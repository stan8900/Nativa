# NATIVA Prototype Acceptance Tests

Use this checklist for the first prototype sprint. Record `t1`, `t2`, `t3`, and `t_total` from the UI latency table after each run.

| ID | Case | Input | Expected Result | Result | t1 | t2 | t3 | t_total | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K-01 | Basic EN -> RU | "Hello, my name is John and I want to schedule a meeting" | Clean Russian text and speech. `t_total < 2000ms`. |  |  |  |  |  |  |
| K-02 | Basic RU -> EN | "Привет, я хочу заказать столик на двоих на пятницу" | Natural English, not a literal word-by-word translation. |  |  |  |  |  |  |
| K-03 | Short phrase | "Yes" | The system does not hang on short words. Latency remains in the same range. |  |  |  |  |  |  |
| K-04 | Long phrase | Any 30+ word sentence | TTS playback starts from the stream before full synthesis finishes. |  |  |  |  |  |  |
| K-05 | Conversation context | Run 1: "I work at a bank". Run 2: "It's been stressful lately" | The second translation uses prior context when resolving "It". |  |  |  |  |  |  |
| K-06 | Background noise | Speak normally with music or background voices playing | VAD reacts to the speaker, not only to background noise. |  |  |  |  |  |  |
| K-07 | Pause inside phrase | "I want... to book... a flight" | Natural short pauses do not split the phrase. |  |  |  |  |  |  |
| K-08 | 10 requests in a row | Send 10 phrases without restarting the server | No crashes, no visible memory growth, stable latency. |  |  |  |  |  |  |
| K-09 | Latency measurement | All cases | Every case has `t1`, `t2`, `t3`, and `t_total` recorded. At least 8 of 10 requests have `t_total < 2000ms`. |  |  |  |  |  |  |
| K-10 | Voice cloning | Record a 10 second voice sample, then run translation | Synthesized voice from the self-hosted model sounds closer to the original speaker than the default voice. |  |  |  |  |  |  |

## Notes

- The app keeps the last 5 turns as translation context.
- The UI latency table keeps all runs from the current browser session and can export CSV.
- K-10 uses the `voiceId` returned by the self-hosted ML server during the current server session. Restarting the web server resets the active voice.
- K-07 should be tested with natural speaking pauses. A silence longer than the configured VAD timeout is intentionally treated as phrase end.
