export const accountDialogCopy = {
  profileIsolationDescription:
    "A separate profile keeps sign-in and configuration isolated. You can then sign in directly in the terminal.",
  accountNamePlaceholder: "e.g. Personal or Work",
  toolLabel: "Tool",
  uninstalledToolSuffix: " · not installed",
  apiKeyLabel: "API key (optional)",
  savedKeyPlaceholder: "Saved · enter to replace",
  nativeKeyPlaceholder: "Alternative to interactive sign-in",
  nativeAuthenticationHelp:
    "For OpenCode, the API key is used for OpenAI. Set up other providers using “Sign in”. Leave the field empty to keep a saved key.",
  formNote: "Credentials are stored locally only.",
};
export const accountsPageCopy = {
  signedIn: "Signed in",
  defaultAccount: "Default account",
  setDefaultAccount: "Use as default",
  useDefaultAccount: (name) => `Use ${name} as default`,
  pageToplineLabel: "WORKSPACE / ACCOUNTS",
  subtle: " Stored locally",
  pageHeadingTitle: "Your accounts",
  pageHeadingDescription: "One workspace. All your identities.",
  localProfileDescription: "Existing CLI profile on the AgentPier server",
  managedProfileWithKey: "Separate profile · API key saved",
  managedProfileDescription: "Separate profile",
  iconButtonAriaLabel: (value1) => `Delete ${value1}`,
  accountInfoHeading: "Everything stays on your computer.",
  accountInfoDescription:
    "Separate profiles have their own sign-in and configuration. Local profiles use the existing CLI sign-in on the AgentPier server. Choose a separate profile as the default account if you have not signed in there yet.",
};
