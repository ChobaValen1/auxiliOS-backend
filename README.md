# AuxiliOS Backend

API de autenticación administrativa, OCR y compatibilidad temporal con el PostgreSQL legado.

## Requisitos

- Node.js 20 o superior.
- Proyecto Supabase con `users` y `roles`.
- Variables de entorno basadas en `.env.example`.

Las variables obligatorias son `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y
`SUPABASE_ANON_KEY`. `OPENAI_API_KEY` es necesaria solamente para `/api/leer-ticket`.

## Desarrollo

```bash
npm ci
npm run ci
npm start
```

`GET /health` permite verificar que el proceso HTTP está disponible sin revelar secretos.

## Orden de despliegue

1. Configurar las variables nuevas en Railway.
2. Autorizar la URL del frontend en `ALLOWED_ORIGINS`.
3. Configurar en Supabase la URL de redirección usada por invitaciones y recuperación.
4. Desplegar este backend y comprobar `/health`.
5. Desplegar el frontend compatible.

No desplegar primero el frontend: su login por DNI depende de `/api/login-by-dni`.

## API PostgreSQL heredada

Las rutas `/api/remitos` y `/api/nuevo-remito` sólo se habilitan si existe `DATABASE_URL`
o `PGHOST`. Permanecen autenticadas durante la migración definitiva a Supabase. Los archivos
locales dejaron de ser públicos; una migración posterior debe mover cualquier upload heredado
a un bucket privado.
