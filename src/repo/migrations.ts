import type Database from 'better-sqlite3';

const migrations = [
  `CREATE TABLE contracts (
    id INTEGER PRIMARY KEY, status TEXT NOT NULL, client TEXT NOT NULL,
    freelancer TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX contracts_status ON contracts(status);
  CREATE INDEX contracts_client ON contracts(client);
  CREATE INDEX contracts_freelancer ON contracts(freelancer);
  CREATE INDEX contracts_created_at ON contracts(created_at);
  CREATE TABLE reputation (address TEXT PRIMARY KEY, completed INTEGER NOT NULL, total REAL NOT NULL);
  CREATE TABLE id_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value INTEGER NOT NULL);
  INSERT INTO id_sequence VALUES (1, 0);`,
];

export function migrate(db: Database.Database): void {
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
    const { version } = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get() as { version: number };
    if (version > migrations.length) throw new Error('Database schema is newer than this application');
    for (let i = version; i < migrations.length; i++) {
      db.exec(migrations[i]);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
    }
  }).immediate();
}
