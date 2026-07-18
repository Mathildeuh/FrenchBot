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

function saveNextStream(date, heure) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ date, heure }, null, 2));
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
  return `📅 Prochain stream : **${next.date}** à **${next.heure}**`;
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
  } catch (err) {
    // Pas en live, ou erreur de connexion : dans les deux cas on considère "pas en live"
    if (isCurrentlyLive) {
      console.log(`⚪ ${TIKTOK_USERNAME} n'est plus en live.`);
      await updateChannelTopic(false);
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
  ];

  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
    } else {
      await client.application.commands.set(commands);
    }
    console.log('✅ Commande /prochain-stream enregistrée.');
  } catch (err) {
    console.error("❌ Impossible d'enregistrer la commande /prochain-stream :", err.message);
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

        const dateInput = new TextInputBuilder()
          .setCustomId('date')
          .setLabel('Date (ex : Dimanche 20 juillet)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const heureInput = new TextInputBuilder()
          .setCustomId('heure')
          .setLabel('Heure (ex : 18h00)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(dateInput),
          new ActionRowBuilder().addComponents(heureInput),
        );

        await interaction.showModal(modal);
      } else {
        await interaction.reply(formatNextStreamText());
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'prochain-stream-modal') {
      const date = interaction.fields.getTextInputValue('date').trim();
      const heure = interaction.fields.getTextInputValue('heure').trim();
      saveNextStream(date, heure);
      await interaction.reply({
        content: `✅ Prochain stream mis à jour : **${date}** à **${heure}**`,
        ephemeral: true,
      });
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

  checkTikTokLive(); // première vérif immédiate (corrigera le topic si elle est déjà en live)
  setInterval(checkTikTokLive, CHECK_INTERVAL);
});

client.login(DISCORD_TOKEN);