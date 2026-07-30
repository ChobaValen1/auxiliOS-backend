'use strict';

function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

function createAuthMiddleware(supabaseAdmin) {
  async function requireAuth(req, res, next) {
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ error: 'No autenticado' });

    try {
      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (authError || !authData?.user) {
        return res.status(401).json({ error: 'Sesión inválida o vencida' });
      }

      const { data: profile, error: profileError } = await supabaseAdmin
        .from('users')
        .select('user_id, role, role_id, is_active, roles(name)')
        .eq('user_id', authData.user.id)
        .single();

      if (profileError || !profile || profile.is_active === false) {
        return res.status(403).json({ error: 'Usuario sin acceso habilitado' });
      }

      req.auth = {
        user: authData.user,
        profile,
        role: profile.roles?.name || profile.role || '',
      };
      return next();
    } catch (error) {
      req.log?.('error', 'auth_validation_failed', { message: error.message });
      return res.status(401).json({ error: 'No se pudo validar la sesión' });
    }
  }

  function requireRoles(...allowedRoles) {
    return (req, res, next) => {
      if (!req.auth || !allowedRoles.includes(req.auth.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      return next();
    };
  }

  return { requireAuth, requireRoles };
}

module.exports = { bearerToken, createAuthMiddleware };
