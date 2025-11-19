import Database from 'better-sqlite3';
console.log('Import successful');
try {
  const db = new Database(':memory:');
  console.log('Database created');
} catch (e) {
  console.error('Error creating database:', e);
}
