require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} = require('discord.js');
const { TikTokLiveConnection } = require('tiktok-live-connector');

// ==================== CONFIGURATION ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
const EULER_API_KEY = process.env.EULER_API_KEY;

// ID du serveur Discord (optionnel) : si défini, la commande /prochain-stream est enregistrée
// sur ce serveur (propagation instantanée). Sinon elle est enregistrée en global (jusqu'à 1h de délai).
const GUILD_ID = process.env.GUILD_ID;

// Seules ces personnes peuvent définir la date du prochain stream via /prochain-stream.
// Tout le monde d'autre ne fait que consulter la date déjà annoncée.
const SCHEDULE_ADMIN_IDS = ['1417205528429334568', '1527356296012238979'];

// Intervalle entre chaque vérification (en ms). 60000 = 1 minute.
// Ne descends pas trop bas pour éviter de te faire rate-limiter.
const CHECK_INTERVAL = 60_000;

// ==========================================================

if (!DISCORD_TOKEN || !CHANNEL_ID || !TIKTOK_USERNAME) {
  console.error('❌ Il manque des variables dans le fichier .env (DISCORD_TOKEN, CHANNEL_ID, TIKTOK_USERNAME).');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel], // requis pour recevoir les messages DM sur un canal pas encore en cache
});

// Fichier où est persistée la date du prochain stream (survit aux redémarrages du bot).
const SCHEDULE_FILE = path.join(__dirname, 'prochain-stream.json');

function loadNextStream() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (err) {
    return null; // pas encore de prochain stream annoncé
  }
}

function saveNextStream(timestamp) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ timestamp }, null, 2));
}

// Renvoie le décalage (en minutes) entre UTC et l'heure de Paris au moment donné,
// pour gérer automatiquement l'heure d'été/hiver sans dépendance externe.
function parisOffsetMinutes(utcGuessMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    timeZoneName: 'shortOffset',
  }).formatToParts(utcGuessMs);
  const match = parts.find((p) => p.type === 'timeZoneName')?.value.match(/GMT([+-]\d+)/);
  return match ? parseInt(match[1], 10) * 60 : 60;
}

// Convertit "JJ/MM/AAAA" + "HH:mm" (saisis en heure de Paris) en timestamp Unix (secondes).
// Renvoie null si le format ou les valeurs sont invalides.
function parseParisDateTime(input) {
  const match = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[h:](\d{2})$/i);
  if (!match) return null;

  const [, day, month, year, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const realUtcMs = utcGuess - parisOffsetMinutes(utcGuess) * 60_000;
  return Math.floor(realUtcMs / 1000);
}

// Inverse de parseParisDateTime : reconstruit "JJ/MM/AAAA HH:mm" en heure de Paris à partir
// d'un timestamp Unix, pour pré-remplir le formulaire d'édition avec les valeurs déjà enregistrées.
function formatParisDateTime(timestampSeconds) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(timestampSeconds * 1000);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

// Fichier où est persisté le planning : jours récurrents (texte libre) + liste de dates ponctuelles
// (timestamps Unix), survit aux redémarrages du bot.
const STREAMS_FILE = path.join(__dirname, 'streams.json');

function loadStreamsPlanning() {
  try {
    const data = JSON.parse(fs.readFileSync(STREAMS_FILE, 'utf8'));
    return { weekly: data.weekly || [], dates: data.dates || [] };
  } catch (err) {
    return { weekly: [], dates: [] };
  }
}

function saveStreamsPlanning(weekly, dates) {
  fs.writeFileSync(STREAMS_FILE, JSON.stringify({ weekly, dates }, null, 2));
}

function buildStreamsEmbed() {
  const { weekly, dates } = loadStreamsPlanning();
  const now = Math.floor(Date.now() / 1000);
  const upcoming = dates.filter((ts) => ts >= now).sort((a, b) => a - b);

  return new EmbedBuilder()
    .setColor(0xFE2C55)
    .setTitle(`📆 Planning de ${TIKTOK_USERNAME}`)
    .addFields(
      {
        name: 'En ce moment',
        value: formatLiveStatusText(),
      },
      {
        name: '🔁 Chaque semaine',
        value: weekly.length ? weekly.map((line) => `• ${line}`).join('\n') : 'Pas encore défini.',
      },
      {
        name: '🗓️ Prochaines dates',
        value: upcoming.length
          ? upcoming.map((ts) => `• <t:${ts}:F> (<t:${ts}:R>)`).join('\n')
          : 'Aucune date programmée pour le moment.',
      },
    )
    .setFooter({ text: 'Surveillance TikTok Live' })
    .setTimestamp();
}

// Le client Discord se reconnecte déjà tout seul en cas de coupure réseau ;
// on se contente de logger pour garder une trace en cas de souci en prod.
client.on('error', (err) => console.error('❌ Erreur client Discord :', err.message));
client.on('shardDisconnect', () => console.warn('⚠️ Déconnecté de Discord, reconnexion automatique en cours...'));
client.on('shardReconnecting', () => console.warn('🔄 Reconnexion à Discord...'));
client.on('shardResume', () => console.log('✅ Connexion Discord rétablie.'));

// Filet de sécurité pour tourner 24h/24 sans se couper sur une erreur inattendue :
// une rejection non gérée est loggée mais ne tue pas le process (le check suivant repartira normalement).
process.on('unhandledRejection', (err) => console.error('❌ Unhandled rejection :', err));

const TOPIC_LIVE = `🔴 En live sur TikTok ! https://www.tiktok.com/@${TIKTOK_USERNAME}/live`;
const TOPIC_OFFLINE = '⚪ Pas en live actuellement';

let isCurrentlyLive = false; // état mémorisé pour ne notifier qu'une seule fois par live

function formatNextStreamText() {
  const next = loadNextStream();
  if (!next) return "📅 Aucun prochain stream n'est annoncé pour le moment.";
  // <t:...:F> = date/heure complète, <t:...:R> = relatif ("dans 3 jours") ;
  // Discord affiche les deux dans le fuseau horaire local de chaque personne qui lit le message.
  return `📅 Prochain stream : <t:${next.timestamp}:F> (<t:${next.timestamp}:R>)`;
}

function formatLiveStatusText() {
  return isCurrentlyLive
    ? `🔴 ${TIKTOK_USERNAME} est en live en ce moment ! https://www.tiktok.com/@${TIKTOK_USERNAME}/live`
    : '⚪ Pas en live actuellement.';
}

// La description (topic) du salon reflète l'état live/pas-live.
// Discord limite les changements de topic (~2 par 10 min), donc on ne l'appelle que sur transition d'état.
async function updateChannelTopic(isLive) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return;
    await channel.setTopic(isLive ? TOPIC_LIVE : TOPIC_OFFLINE);
  } catch (err) {
    console.error('❌ Impossible de mettre à jour la description du salon :', err.message);
  }
}

// Le statut du bot (activité "personnalisée", sans préfixe "Joue à"/"Regarde") reflète l'état du live.
// Appelé à chaque poll tant que le live continue, pas seulement sur la transition, pour que le
// nombre de viewers affiché reste à jour.
function updateBotPresence(isLive, viewerCount) {
  const state = isLive
    ? (typeof viewerCount === 'number'
      ? `🔴 En live avec ${viewerCount.toLocaleString('fr-FR')} viewers`
      : '🔴 En live sur TikTok')
    : '⚪ Pas en live actuellement';

  try {
    client.user.setPresence({
      status: isLive ? 'online' : 'idle',
      activities: [{ name: state, state, type: ActivityType.Custom }],
    });
  } catch (err) {
    console.error('❌ Impossible de mettre à jour le statut du bot :', err.message);
  }
}

async function checkTikTokLive() {
  const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {
    signApiKey: EULER_API_KEY,
  });

  try {
    const state = await connection.connect();

    // Elle vient de passer en live (elle ne l'était pas avant)
    if (!isCurrentlyLive) {
      isCurrentlyLive = true;
      console.log(`🔴 ${TIKTOK_USERNAME} est en live ! Room ID: ${state.roomId}`);
      await updateChannelTopic(true);
      await sendLiveAlert(state);
    }
    // Rafraîchi à chaque poll (pas seulement à la transition) pour que le nombre de viewers reste à jour.
    updateBotPresence(true, state.roomInfo?.user_count);
  } catch (err) {
    // Pas en live, ou erreur de connexion : dans les deux cas on considère "pas en live"
    if (isCurrentlyLive) {
      console.log(`⚪ ${TIKTOK_USERNAME} n'est plus en live.`);
      await updateChannelTopic(false);
      updateBotPresence(false);
    }
    isCurrentlyLive = false;
  } finally {
    // On coupe la connexion webcast, on ne veut pas rester connecté au chat,
    // juste vérifier le statut périodiquement.
    try {
      connection.disconnect();
    } catch (_) {}
  }
}

async function sendLiveAlert(state) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('❌ Salon Discord introuvable, vérifie CHANNEL_ID.');
      return;
    }

    const roomInfo = state.roomInfo;
    const liveUrl = `https://www.tiktok.com/@${TIKTOK_USERNAME}/live`;
    const nickname = roomInfo?.owner?.nickname || TIKTOK_USERNAME;
    const avatarUrl = roomInfo?.owner?.avatar_thumb?.url_list?.[0];
    const cover = roomInfo?.cover?.url_list?.[0];

    const embed = new EmbedBuilder()
      .setColor(0xFE2C55) // rouge TikTok
      .setAuthor({ name: `🔴 ${nickname} vient de lancer son live TikTok !`, iconURL: avatarUrl })
      .setTitle('Rejoindre le live sur TikTok')
      .setURL(liveUrl)
      .setDescription(roomInfo?.title || 'Viens jeter un œil !')
      .setFooter({ text: 'Surveillance TikTok Live' })
      .setTimestamp();

    // roomInfo.user_count est le nombre de viewers ; on ne l'affiche que s'il est réellement disponible.
    if (typeof roomInfo?.user_count === 'number') {
      embed.addFields({ name: '👀 Viewers', value: roomInfo.user_count.toLocaleString('fr-FR'), inline: true });
    }

    if (cover) embed.setImage(cover);
    if (avatarUrl) embed.setThumbnail(avatarUrl);

    const content = `@everyone\n${liveUrl}`;

    await channel.send({
      content,
      embeds: [embed],
      allowedMentions: { parse: ['everyone'] }, // sans ça, Discord n'envoie pas le ping réel
    });
    console.log('✅ Alerte envoyée sur Discord.');
  } catch (err) {
    console.error('❌ Erreur lors de l\'envoi du message Discord :', err.message);
  }
}

async function registerCommands() {
  const commands = [
    { name: 'prochain-stream', description: 'Affiche la date du prochain stream' },
    { name: 'streams', description: 'Affiche le planning (chaque semaine + prochaines dates)' },
  ];

  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
    } else {
      await client.application.commands.set(commands);
    }
    console.log('✅ Commandes /prochain-stream et /streams enregistrées.');
  } catch (err) {
    console.error("❌ Impossible d'enregistrer les commandes :", err.message);
  }
}

// /prochain-stream : les admins définis dans SCHEDULE_ADMIN_IDS obtiennent un formulaire
// (modal) pour mettre à jour la date/heure ; tout le monde d'autre ne fait que la consulter.
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'prochain-stream') {
      if (SCHEDULE_ADMIN_IDS.includes(interaction.user.id)) {
        const modal = new ModalBuilder()
          .setCustomId('prochain-stream-modal')
          .setTitle('Définir le prochain stream');

        const datetimeInput = new TextInputBuilder()
          .setCustomId('datetime')
          .setLabel('Date et heure (heure de Paris)')
          .setPlaceholder('JJ/MM/AAAA HH:mm — ex : 20/07/2026 18:00')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(datetimeInput));

        await interaction.showModal(modal);
      } else {
        await interaction.reply(formatNextStreamText());
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'prochain-stream-modal') {
      const raw = interaction.fields.getTextInputValue('datetime');
      const timestamp = parseParisDateTime(raw);

      if (timestamp === null) {
        await interaction.reply({
          content: '❌ Format invalide. Utilise JJ/MM/AAAA HH:mm, par exemple : `20/07/2026 18:00`.',
          ephemeral: true,
        });
        return;
      }

      saveNextStream(timestamp);
      await interaction.reply({
        content: `✅ Prochain stream mis à jour : <t:${timestamp}:F> (<t:${timestamp}:R>)`,
        ephemeral: true,
      });
      return;
    }

    // /streams : tout le monde voit le planning stylé ; les admins reçoivent en plus,
    // en privé, un bouton pour ouvrir le formulaire d'édition (pré-rempli avec les valeurs actuelles).
    if (interaction.isChatInputCommand() && interaction.commandName === 'streams') {
      await interaction.reply({ embeds: [buildStreamsEmbed()] });

      if (SCHEDULE_ADMIN_IDS.includes(interaction.user.id)) {
        const editButton = new ButtonBuilder()
          .setCustomId('streams-edit-button')
          .setLabel('✏️ Modifier le planning')
          .setStyle(ButtonStyle.Secondary);

        await interaction.followUp({
          components: [new ActionRowBuilder().addComponents(editButton)],
          ephemeral: true,
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'streams-edit-button') {
      if (!SCHEDULE_ADMIN_IDS.includes(interaction.user.id)) {
        await interaction.reply({ content: "❌ Tu n'as pas la permission de modifier le planning.", ephemeral: true });
        return;
      }

      const { weekly, dates } = loadStreamsPlanning();

      const weeklyInput = new TextInputBuilder()
        .setCustomId('weekly')
        .setLabel('Chaque semaine (1 jour par ligne)')
        .setPlaceholder('Lundi 18h00\nMercredi 20h00\nVendredi 18h00')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
      if (weekly.length) weeklyInput.setValue(weekly.join('\n'));

      const datesInput = new TextInputBuilder()
        .setCustomId('dates')
        .setLabel('Dates à venir (JJ/MM/AAAA HH:mm, 1/ligne)')
        .setPlaceholder('20/07/2026 18:00')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
      if (dates.length) datesInput.setValue(dates.map(formatParisDateTime).join('\n'));

      const modal = new ModalBuilder()
        .setCustomId('streams-edit-modal')
        .setTitle('Modifier le planning')
        .addComponents(
          new ActionRowBuilder().addComponents(weeklyInput),
          new ActionRowBuilder().addComponents(datesInput),
        );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'streams-edit-modal') {
      const weekly = interaction.fields
        .getTextInputValue('weekly')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const dateLines = interaction.fields
        .getTextInputValue('dates')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const dates = [];
      const invalidLines = [];
      for (const line of dateLines) {
        const ts = parseParisDateTime(line);
        if (ts === null) invalidLines.push(line);
        else dates.push(ts);
      }

      if (invalidLines.length) {
        await interaction.reply({
          content: `❌ Format invalide pour : ${invalidLines.map((l) => `\`${l}\``).join(', ')}\nUtilise JJ/MM/AAAA HH:mm, une date par ligne.`,
          ephemeral: true,
        });
        return;
      }

      dates.sort((a, b) => a - b);
      saveStreamsPlanning(weekly, dates);
      await interaction.reply({ content: '✅ Planning mis à jour.', ephemeral: true });
      return;
    }
  } catch (err) {
    console.error("❌ Erreur lors du traitement d'une interaction :", err.message);
  }
});

// Réponse automatique en DM : peu importe ce qu'on écrit au bot, il donne la date
// du prochain stream et si le live TikTok est en cours.
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.guild) return;

  console.log(`📩 DM reçu de ${message.author.tag} (${message.author.id})`);
  try {
    await message.channel.send(`${formatNextStreamText()}\n${formatLiveStatusText()}`);
    console.log('✅ Réponse DM envoyée.');
  } catch (err) {
    console.error('❌ Erreur lors de la réponse en DM :', err.message);
  }
});

client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`👀 Surveillance de @${TIKTOK_USERNAME} toutes les ${CHECK_INTERVAL / 1000}s...`);

  await registerCommands();
  await updateChannelTopic(false); // état par défaut au démarrage : pas en live
  updateBotPresence(false);

  checkTikTokLive(); // première vérif immédiate (corrigera le topic si elle est déjà en live)
  setInterval(checkTikTokLive, CHECK_INTERVAL);
});

client.login(DISCORD_TOKEN);