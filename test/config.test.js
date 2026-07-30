'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const REQUIRED_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  SUPABASE_ANON_KEY: 'anon-test',
};

test('loadConfig exige las credenciales de Supabase', () => {
  assert.throws(() => loadConfig({}), /SUPABASE_URL/);
  assert.throws(
    () => loadConfig({ SUPABASE_URL: REQUIRED_ENV.SUPABASE_URL }),
    /SUPABASE_SERVICE_ROLE_KEY/
  );
});

test('loadConfig interpreta orígenes y desactiva PostgreSQL legado por defecto', () => {
  const config = loadConfig({
    ...REQUIRED_ENV,
    ALLOWED_ORIGINS: 'https://uno.example, https://dos.example',
    PORT: '8080',
  });

  assert.equal(config.port, 8080);
  assert.deepEqual(config.allowedOrigins, ['https://uno.example', 'https://dos.example']);
  assert.equal(config.database.enabled, false);
});

test('loadConfig rechaza puertos inválidos', () => {
  assert.throws(() => loadConfig({ ...REQUIRED_ENV, PORT: '70000' }), /PORT/);
});
