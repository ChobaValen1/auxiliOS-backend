# Seguridad de AuxiliOS Backend

## Reporte responsable

No publiques vulnerabilidades, credenciales ni datos personales en un issue público.
Contactá de forma privada al responsable técnico del proyecto e incluí la ruta afectada,
el impacto observado y pasos mínimos para reproducirlo sin usar datos reales.

## Controles obligatorios

- Todo endpoint que lea o modifique datos operativos requiere un JWT válido.
- Las acciones administrativas verifican el rol del lado servidor.
- Las credenciales se configuran únicamente mediante variables de entorno.
- Los uploads aceptan solamente imágenes permitidas y tienen límites de tamaño y cantidad.
- Los errores públicos no incluyen respuestas de proveedores, SQL ni stack traces.
- Los logs identifican la solicitud y al actor, pero no deben contener contraseñas, tokens,
  imágenes, DNI, emails ni cuerpos completos.

## Despliegue

Antes de desplegar, configurar `SUPABASE_ANON_KEY`, revisar `ALLOWED_ORIGINS` y definir
`TRUST_PROXY=true` solamente cuando Railway sea el proxy confiable frente a la aplicación.
La API PostgreSQL heredada queda deshabilitada si no se configura `DATABASE_URL` o `PGHOST`.

La rotación de credenciales, revisión de RLS, backups y restauraciones se gestionan fuera
del repositorio y deben quedar registradas en el control operativo correspondiente.
