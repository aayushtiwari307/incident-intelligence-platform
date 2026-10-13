module.exports = async () => {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests (a superuser/admin connection to a " +
        "scratch PostgreSQL server; tests create and drop their own databases). " +
        "Example: postgresql://platform:<password>@127.0.0.1:5434/postgres",
    );
  }
};
