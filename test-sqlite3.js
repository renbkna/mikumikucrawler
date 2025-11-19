import sqlite3 from 'sqlite3';
console.log('Import successful');
const db = new sqlite3.Database(':memory:', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Database created');
  }
});
