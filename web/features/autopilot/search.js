import { autopilotActionsCopy } from "../../lib/i18n/messages/autopilot-actions.js";
import { controlRoomCopy } from "../../lib/i18n/messages/control-room.js";

const actions = {
  "autopilot-policy": "editPolicy",
  "autopilot-pause": "pause",
  "autopilot-resume": "resume",
  "autopilot-recover": "recover",
  "autopilot-remove": "remove",
};
export const orderActionIds = Object.keys(actions);

export function orderActionEntries(action, bilingual) {
  const path = bilingual(() => controlRoomCopy.title);
  return [
    action("autopilot-new", () => autopilotActionsCopy.newOrder, path, {
      route: { view: "control-room", creating: true },
    }),
    ...orderActionIds.map((id) =>
      action(
        id,
        () => autopilotActionsCopy[actions[id]],
        path,
        { pending: id },
        { offer: id, suggested: false },
      ),
    ),
  ];
}
