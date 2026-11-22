import { Dialog, Drawer, Input, Select, Textarea, Ui } from "@mizook/ui";

/**
 * The interactive pieces the chat needs. Buttons are native, as ui-sdk
 * recommends for a plain press; the composer, agent picker, drawer and rename
 * dialog are ui-sdk behaviors with their state in the Model.
 */
export const kit = Ui.define({
  composer: Textarea.component,
  agent: Select.component,
  drawer: Drawer.component,
  rename: Dialog.component,
  renameInput: Input.component,
});
