// The browser's own refusal ("Registration failed - permission denied") is English
// browser text; the settings show what it means in the app's language instead.
export async function subscribePush(pushManager, options, copy) {
  try {
    return await pushManager.subscribe(options);
  } catch (error) {
    throw new Error(
      error?.name === "NotAllowedError" ? copy.denied : copy.subscribeFailed,
      { cause: error },
    );
  }
}
