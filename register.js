import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('timesheet')
    .setDescription('Post your Favro timesheet entries for today')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('linkfavro')
    .setDescription('Link your Favro account to your Discord user')
    .addStringOption(o =>
      o.setName('email')
       .setDescription('Your Favro login email')
       .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('unlinkfavro')
    .setDescription('Unlink your Favro account')
    .toJSON()
];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId || !guildId) {
    console.error('Missing DISCORD_TOKEN or DISCORD_APP_ID or DISCORD_GUILD_ID in .env');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(appId, guildId),
    { body: commands }
  );

  console.log('✅ Slash commands registered to guild:', guildId);
}

main().catch(err => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
