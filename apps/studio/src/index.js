'use strict';

const guards = require('./studio/guards');
const { ensureRoles } = require('./studio/roles');
const { seed } = require('./studio/seed');

module.exports = {
  /** Validaciones del Studio como middleware del Document Service (PRD §9). */
  register({ strapi }) {
    guards.register({ strapi });
  },

  async bootstrap({ strapi }) {
    await ensureRoles(strapi);
    try {
      await seed(strapi);
    } catch (err) {
      strapi.log.error(`[seed] Falló la carga de ejemplo: ${err.message}`);
    }
  },
};
