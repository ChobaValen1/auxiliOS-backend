'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

function queryResult(data = null, error = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data, error }),
    maybeSingle: async () => ({ data, error }),
    insert: async () => ({ data, error }),
  };
  return chain;
}

function makeApp() {
  const supabaseAdmin = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: new Error('invalid') }),
      admin: {
        inviteUserByEmail: async () => ({ data: null, error: null }),
        deleteUser: async () => ({ error: null }),
      },
    },
    from: () => queryResult(),
  };
  const createSupabasePublicClient = () => ({
    auth: {
      signInWithPassword: async () => ({ data: null, error: new Error('invalid') }),
      resetPasswordForEmail: async () => ({ error: null }),
    },
  });
  const logger = { info() {}, warn() {}, error() {} };
  const config = {
    trustProxy: false,
    allowedOrigins: ['https://auxilios.example'],
    jsonLimit: '1mb',
    uploadDir: '/tmp/auxilios-backend-test-uploads',
    maxUploadBytes: 1024,
    maxUploadFiles: 2,
    passwordResetRedirect: 'https://auxilios.example',
    openaiApiKey: null,
  };
  return createApp({ config, supabaseAdmin, createSupabasePublicClient, pool: null, logger });
}

test('health no expone configuración interna y agrega headers seguros', async () => {
  const response = await request(makeApp()).get('/health').expect(200);
  assert.deepEqual(response.body, { status: 'ok', service: 'auxilios-backend' });
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.ok(response.headers['x-request-id']);
  assert.ok(response.headers['x-content-type-options']);
});

test('operaciones sensibles rechazan solicitudes sin token', async () => {
  await request(makeApp()).post('/api/create-user').send({}).expect(401);
  await request(makeApp()).get('/api/remitos').expect(401);
  await request(makeApp()).post('/api/leer-ticket').send({}).expect(401);
});

test('login por DNI valida el cuerpo y nunca usa el endpoint email-by-dni', async () => {
  await request(makeApp())
    .post('/api/login-by-dni')
    .send({ dni: 'abc', password: '' })
    .expect(400, { error: 'Credenciales inválidas' });
  await request(makeApp()).post('/api/email-by-dni').send({ dni: '30123456' }).expect(404);
});

test('CORS rechaza orígenes no autorizados', async () => {
  await request(makeApp())
    .get('/health')
    .set('Origin', 'https://evil.example')
    .expect(403, { error: 'Origen no permitido' });
});
