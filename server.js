'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { createApp } = require('./src/app');
const { loadConfig } = require('./src/config');

const config = loadConfig();

const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

const createSupabasePublicClient = () => createClient(
  config.supabase.url,
  config.supabase.anonKey,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

const pool = config.database.enabled
  ? new Pool(config.database.poolOptions)
  : null;

const app = createApp({
  config,
  supabaseAdmin,
  createSupabasePublicClient,
  pool,
});

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({
    level: 'info',
    event: 'server_started',
    port: config.port,
    legacyDatabaseEnabled: config.database.enabled,
  }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'server_shutdown', signal }));
  server.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
