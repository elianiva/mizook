import { Array, Record, Option } from "effect";
import type { Html } from "foldkit/html";
import type { SettingKey } from "@mizook/admin-api";

import { overviewQuery } from "../api.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { type H, remote, skeletonView } from "../view/common.ts";
import { ui } from "../ui.ts";

const SETTINGS: ReadonlyArray<{
  readonly key: SettingKey;
  readonly label: string;
  readonly hint: string;
  readonly multiline: boolean;
}> = [
  { key: "model", label: "Model", hint: "provider/model id", multiline: false },
  { key: "budget", label: "Daily budget", hint: "dollars, 0 for none", multiline: false },
  { key: "timezone", label: "Time zone", hint: "IANA name, like Asia/Jakarta", multiline: false },
  {
    key: "instructions",
    label: "Instructions",
    hint: "added to the system prompt",
    multiline: true,
  },
];

export const settingsView = (model: Model, channel: string, h: H): Html =>
  remote(overviewQuery.read(model.overview, { channel }), h, skeletonView(h, 2), (data) =>
    h.div(
      [h.Class(ui.stack)],
      [
        h.p(
          [h.Class(ui.muted)],
          [
            "Saved on this channel only, as its slash commands would. Empty it and save, or reset, to use the default again.",
          ],
        ),
        h.div(
          [h.Class(ui.form)],
          Array.map(SETTINGS, (setting) => {
            const saved = data.settings[setting.key];
            const draft = Record.get(model.drafts, setting.key);
            const shown = Option.getOrElse(draft, () => saved ?? "");
            const changed = Option.isSome(draft) && shown !== (saved ?? "");
            const field = setting.multiline
              ? h.textarea([
                  h.Class(ui.textarea),
                  h.AriaLabel(setting.label),
                  h.Placeholder("default"),
                  h.Value(shown),
                  h.OnInput((value) => Message.UpdatedDraft({ key: setting.key, value })),
                ])
              : h.input([
                  h.Class(`${ui.input} ${ui.fullWidth}`),
                  h.Type("text"),
                  h.AriaLabel(setting.label),
                  h.Placeholder("default"),
                  h.Value(shown),
                  h.OnInput((value) => Message.UpdatedDraft({ key: setting.key, value })),
                ]);
            return h.keyed("div")(
              setting.key,
              [h.Class(ui.field)],
              [
                h.div(
                  [h.Class(ui.fieldLabel)],
                  [
                    h.span([h.Class(ui.strong)], [setting.label]),
                    h.span([h.Class(`${ui.muted} ${ui.mono}`)], [setting.hint]),
                  ],
                ),
                field,
                h.div(
                  [h.Class(ui.toolbar)],
                  [
                    h.button(
                      [
                        h.Type("button"),
                        h.Class(changed ? ui.buttonPrimary : ui.button),
                        h.Disabled(!changed),
                        h.OnClick(Message.ClickedSave({ key: setting.key })),
                      ],
                      ["Save"],
                    ),
                    saved === undefined
                      ? h.empty
                      : h.button(
                          [
                            h.Type("button"),
                            h.Class(ui.button),
                            h.OnClick(Message.ClickedResetSetting({ key: setting.key })),
                          ],
                          ["Reset"],
                        ),
                  ],
                ),
              ],
            );
          }),
        ),
      ],
    ),
  );
