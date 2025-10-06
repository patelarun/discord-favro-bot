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

dayjs.extend(utc);
dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'Europe/Stockholm';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Data folder & mapping file -----
const DATA_DIR = path.join(__dirname, 'data');
const MAP_PATH = path.join(DATA_DIR, 'user-map.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MAP_PATH)) fs.writeFileSync(MAP_PATH, '{}');

function loadMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
}

// ----- Discord client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// ----- Favro API client -----
const favro = axios.create({
  baseURL: 'https://favro.com/api/v1',
  auth: {
    username: process.env.FAVRO_EMAIL,
    password: process.env.FAVRO_TOKEN,
  },
  headers: {
    organizationId: process.env.FAVRO_ORG_ID,
  },
  timeout: 30000,
});

// Ensure required Favro headers are consistently applied and the backend identifier
// returned by Favro is persisted for subsequent requests.
favro.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  if (process.env.FAVRO_ORG_ID) {
    config.headers['organizationId'] = process.env.FAVRO_ORG_ID;
  }
  const persistedBackendId = favro?.defaults?.headers?.common?.['X-Favro-Backend-Identifier'];
  if (persistedBackendId) {
    config.headers['X-Favro-Backend-Identifier'] = persistedBackendId;
  }
  return config;
});

favro.interceptors.response.use((response) => {
  const backendId = response?.headers?.['x-favro-backend-identifier'];
  if (backendId) {
    favro.defaults.headers.common['X-Favro-Backend-Identifier'] = backendId;
  }
  return response;
});

const TIME_CF_ID = process.env.FAVRO_TIME_CF_ID;
if (!TIME_CF_ID)
  console.warn('⚠️  Missing FAVRO_TIME_CF_ID — set this in your environment.');

const WIDGET_IDS = (process.env.FAVRO_WIDGET_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const MAX_PAGES_PER_WIDGET = Number(process.env.FAVRO_MAX_PAGES_PER_WIDGET || 10);

// ----- Helpers -----
function fmtHHMM(ms) {
  const mins = Math.round((ms || 0) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getCardKey(card) {
  const seq = card?.sequentialId ?? card?.cardNumber ?? card?.cardIdShort ?? null;
  const pre = card?.prefix ?? card?.workspacePrefix ?? '';
  if (seq && pre) return `${pre}-${seq}`;
  if (seq) return String(seq);
  if (card?.cardCommonId) return card.cardCommonId.slice(0, 8).toUpperCase();
  return '(card)';
}

function isTodayInTZ(iso) {
  if (!iso) return false;
  const t = dayjs(iso).tz(TZ);
  const s = dayjs().tz(TZ).startOf('day');
  const e = dayjs().tz(TZ).endOf('day');
  return (t.isAfter(s) && t.isBefore(e)) || t.isSame(s) || t.isSame(e);
}

async function findFavroUserByEmail(email) {
  let page = 0, requestId = undefined, pages = 1;
  while (page < pages) {
    const params = {};
    if (requestId) { params.requestId = requestId; params.page = page; }
    const { data, headers } = await favro.get('/users', { params });

    const backendId = headers['x-favro-backend-identifier'];
    if (backendId) favro.defaults.headers.common['X-Favro-Backend-Identifier'] = backendId;

    requestId = data.requestId;
    pages = data.pages || 1;
    for (const u of data.entities || []) {
      if ((u.email || '').toLowerCase() === email.toLowerCase()) return u;
    }
    page++;
  }
  return null;
}

// --- Card lookup utilities ---

// 1) Direct by cardCommonId (fast)
async function fetchCardByCommonId(cardCommonId) {
  try {
    const { data } = await favro.get('/cards', { params: { cardCommonId, include: 'customFields' }});
    return (data.entities || [])[0] || null;
  } catch (err) {
    if (err?.response?.status === 403) {
      return null;
    }
    throw err;
  }
}

// 2) Key search inside known boards (prefix-seq like "BOK-5106")
function parseKey(token) {
  const m = String(token).trim().match(/^([A-Za-z]+)-(\d+)$/);
  return m ? { prefix: m[1].toUpperCase(), sequentialId: Number(m[2]) } : null;
}

// Accept Favro URLs and extract widget and card identifiers so users can paste links.
// Examples:
// https://favro.com/organization/<orgId>/<widgetCommonId>?card=Bok-6074
// https://favro.com/organization/<orgId>/<widgetCommonId>?card=<cardCommonId>
function parseFavroUrlToken(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (!/\.favro\.com$|^favro\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // organization/<org>/<widget>
  const orgIdx = parts.indexOf('organization');
  if (orgIdx === -1 || parts.length < orgIdx + 3) return null;
  const orgId = parts[orgIdx + 1];
  const widgetCommonId = parts[orgIdx + 2];
  const cardParam = url.searchParams.get('card') || '';
  let cardCommonId = null;
  let cardKey = null;
  if (cardParam) {
    if (/^[A-Za-z0-9_-]{8,}$/.test(cardParam) && !cardParam.includes('-')) {
      cardCommonId = cardParam;
    } else if (/^[A-Za-z]+-\d+$/.test(cardParam)) {
      cardKey = cardParam;
    }
  }
  return { orgId, widgetCommonId, cardCommonId, cardKey };
}

// Since the public API doesn’t expose a direct filter by (prefix,sequentialId),
// we scan a few pages per provided board and stop when we find the matching key.
async function findCardByKeyInBoards(key, preferredWidgetId) {
  const orderedWidgets = [];
  if (preferredWidgetId) orderedWidgets.push(preferredWidgetId);
  for (const w of WIDGET_IDS) if (!orderedWidgets.includes(w)) orderedWidgets.push(w);
  if (!orderedWidgets.length) return null;

  for (const widgetCommonId of orderedWidgets) {
    let page = 0, pages = 1, requestId;
    let skipThisWidget = false;
    while (page < pages && page < MAX_PAGES_PER_WIDGET) {
      const params = { widgetCommonId, include: 'basic' };
      if (requestId) { params.requestId = requestId; params.page = page; }
      let data, headers;
      try {
        ({ data, headers } = await favro.get('/cards', { params }));
      } catch (err) {
        if (err?.response?.status === 403) {
          console.warn('Skipping Favro widget due to 403', { widgetCommonId });
          skipThisWidget = true;
          break;
        }
        throw err;
      }

      const backendId = headers['x-favro-backend-identifier'];
      if (backendId) favro.defaults.headers.common['X-Favro-Backend-Identifier'] = backendId;

      requestId = data.requestId;
      pages = data.pages || 1;

      for (const c of data.entities || []) {
        const seq = c?.sequentialId ?? c?.cardNumber ?? c?.cardIdShort;
        const seqNum = seq != null ? Number(seq) : null;
        const pre = (c?.prefix ?? c?.workspacePrefix ?? '').toString().toUpperCase();

        if (seqNum != null && seqNum === key.sequentialId) {
          // If prefix is present in this page and matches, accept immediately (and fetch details if possible)
          if (pre && pre === key.prefix) {
            if (c.cardCommonId) {
              const detailed = await fetchCardByCommonId(c.cardCommonId);
              return detailed || c;
            }
            return c;
          }

          // If prefix is missing in the basic payload, fetch detailed card to verify prefix
          if (c.cardCommonId) {
            const detailed = await fetchCardByCommonId(c.cardCommonId);
            if (detailed) {
              const detailedPre = (detailed?.prefix ?? detailed?.workspacePrefix ?? '').toString().toUpperCase();
              const detailedSeq = detailed?.sequentialId ?? detailed?.cardNumber ?? detailed?.cardIdShort;
              const detailedSeqNum = detailedSeq != null ? Number(detailedSeq) : null;
              if (detailedPre && detailedPre === key.prefix && detailedSeqNum === key.sequentialId) {
                return detailed;
              }
            }
          }
        }
      }
      page++;
    }
    if (skipThisWidget) {
      continue;
    }
  }
  return null;
}

function extractTodaysReports(card, favroUserId, timeCfId) {
  const cf = (card.customFields || []).find(
    (f) => f.customFieldId === timeCfId
  );
  if (!cf || !cf.reports) return [];
  const entries = cf.reports[favroUserId] || [];
  return entries
    .filter((r) => isTodayInTZ(r.createdAt))
    .map((r) => ({
      ms: r.value || 0,
      desc: r.description || '(no description)',
      createdAt: r.createdAt,
    }));
}

// ----- Command Handlers -----
async function handleTimesheet(interaction) {
  await interaction.deferReply();

  const map = loadMap();
  const favroUserId = map[interaction.user.id];
  if (!favroUserId) {
    await interaction.editReply(
      'You are not linked to Favro yet. Run `/linkfavro email:<your-favro-email>` first.'
    );
    return;
  }

  if (!TIME_CF_ID) {
    await interaction.editReply(
      'Bot is missing FAVRO_TIME_CF_ID. Ask an admin to set it in the environment.'
    );
    return;
  }

  const tokensRaw = interaction.options.getString('cards') || '';
  const tokens = tokensRaw
    .split(/[, \n]+/)
    .map(t => t.trim())
    .filter(Boolean);

  if (!tokens.length) {
    await interaction.editReply('Please provide card numbers or IDs, e.g. `/timesheet cards:BOK-5106 BOK-5120`');
    return;
  }

  let results = [];
  try {
    for (const t of tokens) {
      let card = null;
      let preferredWidgetId = null;

      const favroUrlParts = parseFavroUrlToken(t);
      if (favroUrlParts) {
        preferredWidgetId = favroUrlParts.widgetCommonId || null;
        if (favroUrlParts.cardCommonId) {
          card = await fetchCardByCommonId(favroUrlParts.cardCommonId);
        } else if (favroUrlParts.cardKey) {
          const keyFromUrl = parseKey(favroUrlParts.cardKey);
          if (keyFromUrl) {
            card = await findCardByKeyInBoards(keyFromUrl, preferredWidgetId);
          }
        }
      }

      // If it looks like a cardCommonId (long base64-like), try direct:
      if (/^[A-Za-z0-9_-]{8,}$/.test(t) && !t.includes('-')) {
        card = await fetchCardByCommonId(t);
      }

      // Else if it looks like KEY-123:
      if (!card) {
        const key = parseKey(t);
        if (key) {
          card = await findCardByKeyInBoards(key, preferredWidgetId);
        }
      }

      if (!card) {
        // Couldn’t resolve this token
        results.push({ cardKey: t, time: '00:00', desc: '(card not found in scoped boards)' });
        continue;
      }

      const entries = extractTodaysReports(card, favroUserId, TIME_CF_ID);
      if (entries.length) {
        for (const e of entries) {
          results.push({
            cardKey: getCardKey(card),
            time: fmtHHMM(e.ms),
            desc: e.desc,
          });
        }
      } else {
        // Found the card but no timesheet today for this user
        results.push({
          cardKey: getCardKey(card),
          time: '00:00',
          desc: '(no timesheet entry for today)',
        });
      }
    }
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const req = err?.config;
    console.error('Favro fetch failed:', {
      status,
      endpoint: req?.baseURL ? `${req.baseURL}${req.url}` : req?.url,
      method: req?.method,
      params: req?.params,
      data,
    });
    await interaction.editReply('Could not fetch Favro cards right now. Please try again later.');
    return;
  }

  const header = "Today's update";
  const body = results
    .map((r) => `${r.cardKey} - ${r.time}\n* ${r.desc}`)
    .join('\n');

  await interaction.editReply(`${header}\n${body}`);
}

async function handleLink(interaction) {
  const email = interaction.options.getString('email', true);
  await interaction.deferReply({ ephemeral: true });

  try {
    const u = await findFavroUserByEmail(email);
    if (!u) {
      await interaction.editReply(
        `Couldn't find a Favro user with email **${email}**. Check spelling or ask an admin.`
      );
      return;
    }
    const map = loadMap();
    map[interaction.user.id] = u.userId;
    saveMap(map);
    await interaction.editReply(
      `Linked ✅ Your Discord is now connected to Favro user **${u.fullName || u.email}**.`
    );
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

// ----- Discord events -----
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
      await i.reply({
        content: 'Something went wrong. Please try again later.',
        ephemeral: true,
      });
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN missing in environment.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
