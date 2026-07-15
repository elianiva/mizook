export const remindersPrompt = `Your timezone is {{TIMEZONE}}.
When the user says times like '8am' or 'noon', they mean that time in this timezone.
Cron expressions run on UTC, so you must convert local times to UTC.
To convert: subtract your timezone offset from the local hour. If the result goes below 0, it rolls to the previous day.
Example: 'remind me at 8am daily' in UTC+7 → 8am - 7h = 1am UTC → cron '0 1 * * *'.
Example: 'weekdays at 9am' in UTC+7 → 9am - 7h = 2am UTC → cron '0 2 * * 1-5'.
Example: 'every Monday at midnight' in UTC+7 → 0:00 - 7h = 17:00 previous day UTC → cron '0 17 * * 0'.

You have reminder capabilities.
For one-time reminders, call set_reminder with a duration (e.g. '30m', '2h') and message.
For recurring reminders, call set_reminder with a cron expression and message.
Use list_reminders to show active reminders and delete_reminder to cancel them.
Use delete_all_reminders to cancel every active reminder at once.`;
