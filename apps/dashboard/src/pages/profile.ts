import { css } from "../../styled-system/css";
import { Option } from "effect";

import { profileQuery } from "../api.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { type H, remote, skeletonView } from "../view/common.ts";
import { editorFor, agentForm } from "./agent-editor.ts";
import { ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  bullets: css({
    margin: 0,
    paddingInlineStart: "18px",
    listStyle: "square",
    "& li::marker": { color: "accent" },
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  }),

  listStatic: css({
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
  }),
  keyValue: css({
    display: "grid",
    gridTemplateColumns: "90px 1fr",
    gap: "12px",
    padding: "10px 16px",
    fontSize: "sm",
    "& + &": { borderTop: "1px solid {colors.border}" },
  }),
};

export const profileBody = (model: Model, h: H) => {
  const editor = editorFor(model, "profile");
  if (Option.isSome(editor)) return agentForm(model, editor.value, h);
  return remote(profileQuery.read(model.profile), h, skeletonView(h, 1), (profile) =>
    h.div(
      [h.Class(ui.stack)],
      [
        h.div(
          [h.Class(ui.titleRow)],
          [
            h.p([h.Class(ui.muted)], ["Shared by every agent."]),
            h.button(
              [
                h.Type("button"),
                h.Class(ui.buttonSmall),
                h.OnClick(Message.ClickedAgentEdit({ kind: "profile", id: "" })),
              ],
              ["Edit"],
            ),
          ],
        ),
        h.div(
          [h.Class(ui.listStatic)],
          [
            h.div(
              [h.Class(ui.keyValue)],
              [
                h.span([h.Class(ui.strong)], ["About"]),
                h.span(
                  [h.Class(ui.text)],
                  [profile.about.trim() === "" ? "Nothing saved yet." : profile.about],
                ),
              ],
            ),
            h.div(
              [h.Class(ui.keyValue)],
              [
                h.span([h.Class(ui.strong)], ["Rules"]),
                profile.rules.length === 0
                  ? h.span([h.Class(ui.muted)], ["None yet."])
                  : h.ul(
                      [h.Class(ui.bullets)],
                      profile.rules.map((rule, index) => h.keyed("li")(String(index), [], [rule])),
                    ),
              ],
            ),
          ],
        ),
      ],
    ),
  );
};
