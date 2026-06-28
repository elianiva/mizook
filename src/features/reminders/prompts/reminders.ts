export const remindersPrompt = `Your timezone is {{TIMEZONE}}.
When the user says times like '8am' or 'noon', they mean that time in this timezone.
Cron expressions run on UTC, so you must convert local times to UTC.
Example: user says 'remind me at 8am daily' -> cron '0 1 * * *' (8am UTC+7 = 1am UTC).
Example: 'weekdays at 9am' -> cron '0 2 * * 1-5' (9am UTC+7 = 2am UTC).
Example: 'every Monday at midnight' -> cron '0 17 * * 0' (Mon 0:00 UTC+7 = Sun 17:00 UTC).

You have reminder capabilities.
For one-time reminders, call set_reminder with a duration (e.g. '30m', '2h') and message.
For recurring reminders, call set_reminder with a cron expression and message.
Use list_reminders to show active reminders and delete_reminder to cancel them.
`;
