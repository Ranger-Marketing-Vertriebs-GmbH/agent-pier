export const loginCopy = Object.freeze({
  title: "Sign in",
  setup: "Create user",
  welcome: "Welcome to AgentPier",
  description: "Sign in to open your workspace.",
  setupDescription:
    "Choose your username and password. You own this workspace and can add more users later.",
  setupElsewhere:
    "This workspace has no owner yet. The owner is set up on the AgentPier computer itself or through their own Tailscale account; you can sign in here afterwards.",
  username: "Username",
  password: "Password",
  repeat: "Repeat password",
  passwordHint: "At least 12 characters",
  mismatch: "Passwords do not match.",
  loading: "Checking sign-in …",
  pending: "Please wait …",
  retry: "Try again",
  failed: "Could not check sign-in.",
  errors: {
    LOGIN_ALREADY_CONFIGURED: "A user has already been created. Please sign in.",
    LOGIN_USERNAME_INVALID: "Enter a username with 1 to 100 characters.",
    LOGIN_USERNAME_TAKEN: "A user already has this username. Choose another one.",
    LOGIN_PASSWORD_INVALID: "The password must be 12 to 1024 characters long.",
    LOGIN_CREDENTIALS_INVALID: "Username or password is incorrect.",
    LOGIN_THROTTLED: "Too many sign-in attempts. Please wait a minute.",
    LOGIN_REQUIRED: "Please sign in.",
    LOGIN_SETUP_LOCAL_ONLY:
      "The owner is set up on the AgentPier computer itself or through their own Tailscale account.",
  },
  logout: "Sign out",
});
