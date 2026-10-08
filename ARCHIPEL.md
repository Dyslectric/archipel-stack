The Archipel Plan:

- A federated messager
    - Identites and inboxes are held by a server
    - Users can make channels '#channel@instance.domain'
    - Once users create a channel, they may blacklist/whitelist from it
      or delegate access control to other users.
    - Browser/PWA based notifications for desktop and phone
    - Users may decide to rehome channels that they are a part of and mirror
      the conversation to another server. Other users may join the mirror
      for redundancy (in case, say, one instance gets blocked).
    - We want channels to be able to be set to single-timeline, topical,
      or threaded
    - We want threaded channels to look a lot like comment sections do in
      threadbnc.
    - We want oidc login and we want to be able to let users decide to
      share or not share their verified socials (using fedidp).
    - Instance admins should be able to manage what users are allowed to
      participate in federated conversation or what instances/identites are
      blocked from interacting with the instance. They should also be able
      to inspect chats and delete / ban users.
    - We should look at https://github.com/ConsortChat/ConsortStack to see
      how we will provide identities to jitsi calls for voice channels
    - We want to use activitypub protocols as much as possible and also want to
      be able to send messages to and receive from lemmy/piefed instances.
    - We want XMPP support using Prosody as the backend, with Archipel providing
      the browser frontend and integration with its identities and channels.
    - Eventually the complete application, including its Prosody backend, should
      be distributable as a single executable without separately installing
      Node, Lua, Prosody, or Docker. See docs/xmpp-packaging.md for the proposal.
