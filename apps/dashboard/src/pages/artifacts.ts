import { css } from "../../styled-system/css";
import { Array, Option } from "effect";
import type { Html } from "foldkit/html";
import { isArmed } from "@mizook/ui/confirmation";
import type { ArtifactRow } from "@mizook/admin-api";

import { artifactQuery, artifactsQuery } from "../api.ts";
import { ago, count } from "../format.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { artifactsRouter } from "../route.ts";
import { type H, remote, skeletonView, sectionView, emptyView } from "../view/common.ts";
import { ui as shared, textarea } from "../ui.ts";

const ui = {
  ...shared,
  tileKind: css({
    fontFamily: "mono",
    fontSize: "xl",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "caps",
    color: "accent",
    lineHeight: "1.1",
    wordBreak: "break-all",
  }),
  tileHatch: css({
    backgroundImage:
      "repeating-linear-gradient(135deg, transparent 0 7px, {colors.border} 7px 8px)",
  }),
  artifactName: css({ fontSize: "xl", letterSpacing: "tight", wordBreak: "break-word" }),
  urlLine: css({
    fontFamily: "mono",
    fontSize: "xs",
    padding: "8px 10px",
    border: "1px dashed {colors.borderStrong}",
    backgroundColor: "bgSubtle",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  urlOff: css({ color: "fgFaint", borderColor: "border" }),
  composerBody: css(textarea, { minHeight: "160px" }),
  actionsRow: css({ display: "flex", gap: "6px", flexWrap: "wrap" }),
};

const deleteButton = (model: Model, row: ArtifactRow, h: H): Html => {
  const armed = isArmed(model.armed, `artifact-delete:${row.name}`);
  return h.button(
    [
      h.Type("button"),
      h.Class(armed ? ui.buttonSmallArmed : ui.buttonSmall),
      h.OnClick(Message.ClickedArtifact({ name: row.name, action: "delete" })),
    ],
    [armed ? "Confirm delete" : "Delete"],
  );
};

const kindLabel = (contentType: string): string => {
  const type = contentType.split(";")[0] ?? "";
  return type.includes("table")
    ? "table"
    : type.includes("chart")
      ? "chart"
      : type.includes("markdown")
        ? "markdown"
        : type.includes("html")
          ? "html"
          : (type.split("/")[1] ?? "file");
};

const visibilityToggle = (row: ArtifactRow, h: H): Html =>
  h.div(
    [h.Class(ui.segmented), h.Role("group"), h.AriaLabel(`Link of ${row.name}`)],
    Array.map(["public", "private"] as const, (choice) => {
      const on = row.visibility === choice;
      return h.button(
        [
          h.Type("button"),
          h.Class(ui.segment),
          h.AriaCurrent(on ? "page" : "false"),
          ...(on ? [] : [h.OnClick(Message.ClickedArtifact({ name: row.name, action: choice }))]),
        ],
        [choice],
      );
    }),
  );

const artifactCard = (model: Model, channel: string, row: ArtifactRow, h: H): Html => {
  const isPublic = row.visibility === "public";
  return h.keyed("div")(
    row.name,
    [h.Class(ui.card)],
    [
      h.div(
        [h.Class(isPublic ? ui.cardWhen : `${ui.cardWhen} ${ui.tileHatch}`)],
        [
          h.span([h.Class(ui.tileKind)], [kindLabel(row.contentType)]),
          h.span([h.Class(`${ui.muted} ${ui.mono}`)], [`v${row.version}`]),
        ],
      ),
      h.div(
        [h.Class(ui.cardBody)],
        [
          h.div(
            [h.Class(ui.cardHead)],
            [h.span([h.Class(`${ui.strong} ${ui.artifactName}`)], [row.name])],
          ),
          h.div(
            [h.Class(`${ui.muted} ${ui.mono}`)],
            [`${row.contentType.split(";")[0] ?? ""} · updated ${ago(row.updated)}`],
          ),
          h.div(
            [h.Class(`${ui.urlLine} ${isPublic ? "" : ui.urlOff}`)],
            [isPublic ? row.url : "Link closed"],
          ),
          h.div(
            [h.Class(ui.cardFoot)],
            [
              visibilityToggle(row, h),
              h.div(
                [h.Class(ui.actionsRow)],
                [
                  ...(isPublic
                    ? [
                        h.a(
                          [
                            h.Class(ui.buttonSmall),
                            h.Href(row.url),
                            h.Target("_blank"),
                            h.Rel("noopener noreferrer"),
                          ],
                          ["Open"],
                        ),
                      ]
                    : []),
                  h.a(
                    [
                      h.Class(ui.buttonSmall),
                      h.Href(
                        artifactsRouter({
                          channel: Option.some(channel),
                          name: Option.some(row.name),
                        }),
                      ),
                    ],
                    ["Source"],
                  ),
                  deleteButton(model, row, h),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const artifactSourceView = (model: Model, channel: string, name: string, h: H): Html =>
  remote(artifactQuery.read(model.artifact, { channel, name }), h, skeletonView(h, 1), (data) =>
    h.div(
      [h.Class(ui.stack)],
      [
        h.div(
          [h.Class(ui.metaRow)],
          [
            h.span([h.Class(ui.strong)], [data.artifact.name]),
            h.span([h.Class(ui.mono)], [data.artifact.contentType]),
            h.span([h.Class(ui.mono)], [`${count(data.size)} bytes`]),
            h.a(
              [
                h.Class(ui.link),
                h.Href(artifactsRouter({ channel: Option.some(channel), name: Option.none() })),
              ],
              ["Close"],
            ),
          ],
        ),
        h.pre([h.Class(ui.pre)], [data.text]),
      ],
    ),
  );

export const composerView = (model: Model, h: H): Html => {
  const { name, kind, content } = model.composer;
  const ready = name.trim() !== "" && content.trim() !== "";
  return sectionView(
    "Publish",
    h.div(
      [h.Class(ui.stack)],
      [
        h.div(
          [h.Class(ui.toolbar)],
          [
            h.input([
              h.Class(ui.input),
              h.Type("text"),
              h.AriaLabel("Name"),
              h.Placeholder(kind === "html" ? "my-page.html" : "my-notes"),
              h.Value(name),
              h.OnInput((value) => Message.UpdatedComposer({ field: "name", value })),
            ]),
            h.div(
              [h.Class(ui.segmented), h.Role("group"), h.AriaLabel("Kind")],
              Array.map(["markdown", "html"] as const, (choice) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(ui.segment),
                    h.AriaCurrent(kind === choice ? "page" : "false"),
                    h.OnClick(Message.UpdatedComposer({ field: "kind", value: choice })),
                  ],
                  [choice],
                ),
              ),
            ),
          ],
        ),
        h.textarea([
          h.Class(ui.composerBody),
          h.AriaLabel("Content"),
          h.Placeholder(kind === "html" ? "<h1>Paste HTML</h1>" : "# Paste Markdown"),
          h.Value(content),
          h.OnInput((value) => Message.UpdatedComposer({ field: "content", value })),
        ]),
        h.div(
          [h.Class(ui.toolbar)],
          [
            h.button(
              [
                h.Type("button"),
                h.Class(ui.buttonPrimary),
                h.Disabled(!ready),
                h.OnClick(Message.ClickedPublish()),
              ],
              ["Publish"],
            ),
          ],
        ),
      ],
    ),
    h,
  );
};

export const artifactsView = (
  model: Model,
  channel: string,
  name: Option.Option<string>,
  h: H,
): Html =>
  remote(artifactsQuery.read(model.artifacts, { channel }), h, skeletonView(h, 1), (rows) =>
    Array.match(rows, {
      onEmpty: () => emptyView("No artifacts have been published.", h),
      onNonEmpty: (list) =>
        h.div(
          [h.Class(ui.stack)],
          [
            h.div(
              [h.Class(ui.cards)],
              Array.map(list, (row) => artifactCard(model, channel, row, h)),
            ),
            ...Option.match(name, {
              onNone: () => [],
              onSome: (value) => [
                sectionView("Source", artifactSourceView(model, channel, value, h), h),
              ],
            }),
          ],
        ),
    }),
  );
