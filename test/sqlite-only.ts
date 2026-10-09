// Tests that start from an older SQLite file check SQLite's upgrade path, and only run there.
export const sqliteOnly = {
  skip: process.env.ARCHIPEL_TEST_POSTGRES ? "upgrades a SQLite file" : false,
};
