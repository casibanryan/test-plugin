// servers/greeting-server.js
// MCP stdio server for the greeting plugin — composition root.
// Two tools, no auth, no network: say hello, then react to how the day is going.
//
// Run modes:
//   node servers/greeting-server.js             stdio MCP server (how a host launches it)
//   node servers/greeting-server.js --selftest  exercise both tools, print JSON, exit
// The self-test is what CI and the Docker HEALTHCHECK use to prove the image boots.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const greet = require('./tools/greet');
const dayCheck = require('./tools/day-check');

const TOOL_MODULES = [greet, dayCheck];
const SERVER_INFO = { name: 'greeting', version: require('./package.json').version };

function selftest() {
  return {
    ok: true,
    server: SERVER_INFO.name,
    version: SERVER_INFO.version,
    node: process.version,
    tools: ['greeting_hello', 'greeting_day_check'],
    samples: [
      greet.greetingHello({ name: 'World', hour: 9 }),
      dayCheck.greetingDayCheck({ name: 'World', answer: 'pretty good, thanks' }),
    ],
  };
}

async function main() {
  const server = new McpServer(SERVER_INFO);
  for (const mod of TOOL_MODULES) mod.register(server);
  await server.connect(new StdioServerTransport());
}

module.exports = {
  SERVER_INFO,
  selftest,
  greetingHello: greet.greetingHello,
  greetingDayCheck: dayCheck.greetingDayCheck,
};

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    console.log(JSON.stringify(selftest(), null, 2));
  } else {
    main().catch((e) => { console.error(e); process.exit(1); });
  }
}
