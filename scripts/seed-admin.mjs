// Prints the SQL that creates the one admin the checks sign in as.
//
// Signup deliberately has no path that hands out admin: every account starts
// pending and somebody with database access promotes the first one. That is
// the right shape for a real deployment and an awkward one for a machine, so
// this writes the row directly, hashing the password with the same function
// the sign-in path verifies against rather than a copy of it.
//
// Prints rather than executes, because writing to the local D1 means going
// through wrangler:
//
//   node scripts/seed-admin.mjs > seed.sql
//   npx wrangler d1 execute trip-vara --local --file seed.sql
//
// Test credentials only. Nothing here is a secret and nothing here should ever
// exist in a deployed database.

import { hashPassword } from '../src/util.js';

const email = process.env.SMOKE_ADMIN_EMAIL || 'local@test.dev';
const password = process.env.SMOKE_ADMIN_PASSWORD || 'local-test-12345';

const hash = await hashPassword(password);
const ts = Date.now();
const id = crypto.randomUUID();

// Single-quotes doubled, the SQLite escape, in case a name ever carries one.
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

process.stdout.write(
  `INSERT OR REPLACE INTO users
     (id, email, password_hash, first_name, last_name, agency_name,
      role, status, created_at, updated_at)
   VALUES (${q(id)}, ${q(email)}, ${q(hash)}, 'Local', 'Admin', 'Trip Vara',
           'admin', 'active', ${ts}, ${ts});\n`
);
