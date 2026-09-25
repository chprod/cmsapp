'use strict';

/**
 * Roles del Studio (PRD §12). Se crean al arrancar si no existen.
 *
 * | Rol              | Experiencias           | Publicar | Audiencias | Registro / kill switch |
 * | Editor           | crear, editar, leer    | —        | leer       | leer                   |
 * | Aprobador        | crear, editar, leer    | ✓        | leer       | leer                   |
 * | Growth / Data    | leer                   | —        | CRUD       | leer                   |
 * | DS Admin         | leer                   | —        | leer       | CRUD                   |
 * | Viewer (dev, QA) | leer                   | —        | leer       | leer                   |
 *
 * La matriz se firma con el negocio antes de Fase 1 (riesgo "gobierno difuso", §20).
 */
const CM = 'plugin::content-manager.explorer';
const EXP = 'api::experience.experience';
const AUD = 'api::audience.audience';
const REG = 'api::component-registry.component-registry';
const SEG = 'api::store-segment.store-segment';
const ALL = [EXP, AUD, REG, SEG];

const read = (subjects) => subjects.map((subject) => ({ action: `${CM}.read`, subject }));
const crud = (subject) => ['create', 'read', 'update', 'delete'].map((a) => ({ action: `${CM}.${a}`, subject }));
const releases = (publish) =>
  ['read', 'create', 'update', 'delete', 'create-action', 'delete-action', ...(publish ? ['publish'] : [])].map((a) => ({
    action: `plugin::content-releases.${a}`,
    subject: null,
  }));
const upload = ['read', 'assets.create', 'assets.update', 'assets.download', 'assets.copy-link'].map((a) => ({
  action: `plugin::upload.${a}`,
  subject: null,
}));

const ROLES = [
  {
    name: 'Editor de experiencias',
    description: 'Marketing Digital y Comercial: arma y programa experiencias, las envía a revisión. No publica.',
    permissions: [
      ...['create', 'read', 'update'].map((a) => ({ action: `${CM}.${a}`, subject: EXP })),
      ...read([AUD, REG, SEG]),
      ...releases(false),
      ...upload,
    ],
  },
  {
    name: 'Aprobador',
    description: 'Líder de canal: revisa diff y preview, publica y hace rollback.',
    permissions: [...crud(EXP), { action: `${CM}.publish`, subject: EXP }, ...read([AUD, REG, SEG]), ...releases(true), ...upload],
  },
  {
    name: 'Growth / Data',
    description: 'Define audiencias y segmentos de tiendas.',
    permissions: [...crud(AUD), ...crud(SEG), ...read([EXP, REG])],
  },
  {
    name: 'DS Admin',
    description: 'Design System: certifica componentes, versiona el contrato y opera el kill switch.',
    permissions: [...crud(REG), ...read([EXP, AUD, SEG])],
  },
  {
    name: 'Viewer',
    description: 'Dev y QA: solo lectura.',
    permissions: read(ALL),
  },
];

async function ensureRoles(strapi) {
  const roleService = strapi.service('admin::role');
  const actionProvider = strapi.service('admin::permission').actionProvider;
  for (const def of ROLES) {
    try {
      const existing = await roleService.findOne({ name: def.name });
      if (existing) continue;
      const role = await roleService.create({ name: def.name, description: def.description });
      // Releases es de pago (Growth): si la licencia no lo trae, se omiten esas acciones.
      const permissions = def.permissions.filter((p) => actionProvider.has(p.action));
      await roleService.assignPermissions(role.id, permissions);
      strapi.log.info(`[studio] Rol creado: ${def.name} (${permissions.length} permisos)`);
    } catch (err) {
      strapi.log.warn(`[studio] No se pudo crear el rol "${def.name}": ${err.message}`);
    }
  }
}

module.exports = { ensureRoles, ROLES };
