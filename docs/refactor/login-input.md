# Native Claude login

The account Sign in action starts the regular Claude TUI in the selected managed account, using the same account environment as work sessions. It does not use the non-echoing `claude auth login` prompt or a separate code input form. Login sessions retain their native terminal and do not inject work-session permissions or background integrations during authentication.

The Terminal tab explicitly restores keyboard focus when clicked, including when already selected. Browser regression coverage verifies paste reaches the terminal once without implicit submission. Account authentication is checked separately through the native read-only status command using the matching profile; a successful result replaces the Sign in action with an authenticated indicator.

The earlier no-echo investigation used isolated CLI credentials and synthetic input. No real authorization code was entered by the test runner.
