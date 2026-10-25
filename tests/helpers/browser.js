export const baseURL =
  process.env.AGENTPIER_TEST_URL ||
  `http://127.0.0.1:${process.env.AGENTPIER_TEST_PORT || 4389}`;
