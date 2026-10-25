/** English product copy, addressed through the same semantic keys as the German catalog. */
export const secrets = Object.freeze({
  invalidName:
    "Invalid secret name. Use capital letters, digits and underscores, starting with a letter or underscore, at most 64 characters.",
  invalidDescription: "The description can be at most 200 characters long.",
  invalidValue: "Invalid value. Use 1 to 8192 bytes without a NUL character.",
  invalidProject: "Invalid project for the secret.",
  invalidBody: "Invalid request. Only name, description, project and value are allowed.",
  nameTaken: "A secret with this name already exists.",
  limit: "At most 200 secrets are possible.",
  invalidSessionSelection:
    "Invalid secret selection. A session can receive at most 50 different secrets.",
  loginSessionsUnsupported: "Secrets are not available for sign-in sessions.",
  notFound: "Secret not found.",
});
