import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';

dayjs.extend(utc); dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'Europe/Stockholm';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Data folder & mapping file
const DATA_DIR = path.join(__dirname, 'data');
const MAP_PATH = path.join(DATA_DIR, 'user-map.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MAP_PATH)) fs.writeFileSync(MAP_PATH, '{}');

function loadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); }
  catch { return {}; }
}
function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
}

// ----- Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// ----- Favro API client
const favro = axios.create({
  baseURL: 'https://favro.com/api/v1',
  auth: {
    username: process.env.FAVRO_EMAIL,
    password: process.env.FAVRO_TOKEN
  },
  headers: {
    organizationId: process.env.FAVRO_ORG_ID
  },
  timeout: 30000
});

const TIME_CF_ID = process.env.FAVRO_TIME_CF_ID;
if (!TIME_CF_ID) console.warn('⚠️  Missing FAVRO_TIME_CF_ID — set this in your environment.');

// Helpers
function fmtMS(ms) {
  const mins = Math.round((ms || 0) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function isTodayInTZ(iso) {
  if (!iso) return false;
  const t = dayjs(iso).tz(TZ);
  const s = dayjs().tz(TZ).startOf('day');
  const e = dayjs().tz(TZ).endOf('day');
  return t.isAfter(s) && t.isBefore(e) || t.isSame(s) || t.isSame(e);
}

async function findFavroUserByEmail(email) {
  let page = 0, requestId = undefined, pages = 1;
  while (page < pages) {
    const params = {};
    if (requestId) { params.requestId = requestId; params.page = page; }
    const { data } = await favro.get('/users', { params });
    requestId = data.requestId;
    pages = data.pages || 1;
    for (const u of (data.entities || [])) {
      if ((u.email || '').toLowerCase() === email.toLowerCase()) return u;
    }
    page++;
  }
  return null;
}

// Iterate cards (limited pages to avoid runaway)
async function* iterateCards(maxPages = 10) {
  let page = 0, requestId = undefined, pages = 1;
  while (page < pages && page < maxPages) {
    const params = { include: 'customFields' };
    if (requestId) { params.requestId = requestId; params.page = page; }
    const { data, headers } = await favro.get('/cards', { params });
    requestId = data.requestId;
    pages = data.pages || 1;
    // pass through backend id if present (recommendation from Favro)
    const b = headers['x-favro-backend-identifier'];
    if (b) favro.defaults.headers['X-Favro-Backend-Identifier'] = b;

    for (const c of (data.entities || [])) yield c;
    page++;
  }
}

function extractTodaysReports(card, favroUserId, timeCfId) {
  const cf = (card.customFields || []).find(f => f.customFieldId === timeCfId);
  if (!cf || !cf.reports) return [];
  const entries = cf.reports[favroUserId] || [];
  return entries
    .filter(r => isTodayInTZ(r.createdAt))
    .map(r => ({
      ms: r.value || 0,
      desc: r.description || '(no description)',
      createdAt: r.createdAt
    }));
}

async function handleTimesheet(interaction) {
  await interaction.deferReply(); // public reply in the channel

  const map = loadMap();
  const favroUserId = map[interaction.user.id];
  if (!favroUserId) {
    await interaction.editReply('You are not linked to Favro yet. Run `/linkfavro email:<your-favro-email>` first.');
    return;
  }

  if (!TIME_CF_ID) {
    await interaction.editReply('Bot is missing FAVRO_TIME_CF_ID. Ask an admin to set it in the environment.');
    return;
  }

  let results = [];
  for await (const card of iterateCards(20)) { // scan up to ~20 pages on first go
    const entries = extractTodaysReports(card, favroUserId, TIME_CF_ID);
    if (entries.length) {
      for (const e of entries) {
        results.push({
          cardName: card.name || '(unnamed card)',
          time: fmtMS(e.ms),
          desc: e.desc
        });
      }
    }
  }

  const d = dayjs().tz(TZ).format('YYYY-MM-DD');

  if (!results.length) {
    await interaction.editReply(`No Favro timesheet entries found for **${d}**.`);
    return;
  }

  const lines = results
    .map(r => `• **${r.time}** — ${r.desc} _(on “${r.cardName}”)_`)
    .join('\n');

  await interaction.editReply(`🕒 **Your Favro timesheet for ${d} (${TZ})**\n${lines}`);
}

async function handleLink(interaction) {
  const email = interaction.options.getString('email', true);
  await interaction.deferReply({ ephemeral: true });

  try {
    const u = await findFavroUserByEmail(email);
    if (!u) {
      await interaction.editReply(`Couldn't find a Favro user with email **${email}**. Check spelling or ask an admin.`);
      return;
    }
    const map = loadMap();
    map[interaction.user.id] = u.userId;
    saveMap(map);
    await interaction.editReply(`Linked ✅ Your Discord is now connected to Favro user **${u.fullName || u.email}**.`);
  } catch (err) {
    await interaction.editReply(`Link failed: ${err.message}`);
  }
}

async function handleUnlink(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const map = loadMap();
  if (map[interaction.user.id]) {
    delete map[interaction.user.id];
    saveMap(map);
    await interaction.editReply('Unlinked ✅');
  } else {
    await interaction.editReply('You were not linked.');
  }
}

// ----- Discord events
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === 'timesheet') return handleTimesheet(i);
    if (i.commandName === 'linkfavro') return handleLink(i);
    if (i.commandName === 'unlinkfavro') return handleUnlink(i);
  } catch (err) {
    console.error('Interaction error:', err);
    if (i.deferred || i.replied) {
      await i.editReply('Something went wrong. Please try again later.');
    } else {
      await i.reply({ content: 'Something went wrong. Please try again later.', ephemeral: true });
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN missing in environment.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
