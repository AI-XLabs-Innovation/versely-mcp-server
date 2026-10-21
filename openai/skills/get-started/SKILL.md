---
name: get-started
description: Set up Versely after it is installed. Confirms the Versely account is connected, asks what the user makes, offers to save their brand from a link, and suggests a first piece of short-form content. Use when the user runs setup, says they just installed or connected Versely, or asks how to get started with Versely.
---

# Get started with Versely

The user's own requests come first. If they already asked for something specific, do that and skip this walkthrough.

1. **Check the connection.** Call `versely_get_credits`.
   - If it fails with a sign-in error, ask the user to sign in to Versely when ChatGPT prompts them, and stop until they have.
   - If it works, say in one line that Versely is connected and how many credits the account has. If the balance is 0, say that making media uses credits from their Versely account, which they manage on versely.studio. Do not link to pricing, plans or checkout, and do not suggest buying anything.

2. **Ask one question**, in a single message, and wait for the answer: what they make and for whom (a brand, product, app or personal account), and where they post it.

3. **Offer to save their brand** if they have a website, product page or social profile. Call `versely_analyze_brand` with the link they give; it takes up to a minute. Show a short summary and anything marked uncertain, and let them correct it with `versely_update_brand`. Never guess a link.

4. **Suggest three first pieces** that fit their answer, one line each. For example:
   - a short vertical video from a prompt (`versely_generate_video`);
   - a photo carousel with text on every slide (`versely_create_automated_slideshow`, or `versely_create_brand_slideshow` once a brand is saved);
   - viral formats in their niche to recreate (`versely_find_inspiration`).

   Browsing viral formats uses no credits; making media does. Let the user pick, and say what a job will make before starting it.

5. **Publishing is optional.** Only if the user wants to post from ChatGPT: check `versely_list_social_accounts`. If the platform they want is not connected, call `versely_get_social_auth_url` and give them the link to connect it themselves.

## Rules

- Never publish or schedule a post unless the user asks for that specific post.
- A job that is still running is not finished. Check it with `versely_get_task_status` and say it is still working; never describe a result you have not received.
- Keep each message short. Do not list every Versely feature.
