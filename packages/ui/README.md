# @mizook/ui

The UI SDK adapter for Foldkit.

The adapter comes from [elianiva/foldlab](https://github.com/elianiva/foldlab), an experiment by the same author, under GPL-3.0-or-later. The repository `LICENSE` is GPL-3.0-only.

- `@mizook/ui` exports the components: state in the Model, Messages out, and `parts` views that use ui-sdk behaviors.
- `@mizook/design/preset` and `@mizook/design/styles.css` are in the separate `@mizook/design` package, so this adapter stays usable without the Mizook preset.

The adapter pins `@ui-sdk/core@0.1.0-beta.7`. It imports `@ui-sdk/core/renderer`, which ui-sdk marks as non-public API, so a beta upgrade is its own task with these tests.
