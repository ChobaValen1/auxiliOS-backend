'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCreateUser, validateDniLogin, validateUserId } = require('../src/validation');

test('validateDniLogin normaliza un DNI válido sin exponer email', () => {
  const result = validateDniLogin({ dni: ' 30123456 ', password: 'secreto' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { dni: '30123456', password: 'secreto' });
});

test('validateDniLogin devuelve un error genérico para entradas inválidas', () => {
  assert.deepEqual(validateDniLogin({ dni: 'abc', password: '' }), {
    ok: false,
    error: 'Credenciales inválidas',
  });
});

test('validateCreateUser valida email, rol y DNI', () => {
  const valid = validateCreateUser({
    full_name: 'Ada Lovelace',
    email: 'ADA@EXAMPLE.COM',
    legajo: ' ch-10 ',
    role_name: 'chofer',
    dni: '30123456',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.email, 'ada@example.com');
  assert.equal(valid.value.legajo, 'CH-10');

  assert.equal(validateCreateUser({
    full_name: 'Ada Lovelace',
    email: 'sin-arroba',
    legajo: '10',
    role_name: 'superadmin',
  }).ok, false);
});

test('validateUserId requiere un identificador no vacío y razonable', () => {
  assert.equal(validateUserId({ userId: '123' }).ok, false);
  assert.equal(validateUserId({ userId: '00000000-0000-0000-0000-000000000000' }).ok, true);
});
