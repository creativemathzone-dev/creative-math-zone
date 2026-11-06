# Passkey sign-in setup

The portals keep username and password as a recovery option and add passkeys as an optional sign-in method. A device may ask for a fingerprint, face, device PIN, or security key; the app cannot require fingerprint specifically.

## Enable passkeys in Supabase

Before passkey registration or sign-in will work, enable Supabase Auth passkeys:

1. Open the Creative Math Zone project in the Supabase Dashboard.
2. Go to **Authentication → Passkeys**.
3. Enable passkey authentication.
4. Set the relying party display name to `Creative Math Zone`.
5. Set the relying party ID to `creativemathzone.in`.
6. Set allowed origins to `https://creativemathzone.in` (and `https://www.creativemathzone.in` only if that hostname serves the portal).
7. Save the configuration.

Choose the relying party ID carefully and keep it stable after students register credentials. Changing it makes existing passkeys unusable. The portal currently loads the Supabase JavaScript SDK v2.105.0 from jsDelivr; normal password sign-in remains available if the CDN or passkey service is unavailable.

## Student or teacher setup

Sign in with the current Student ID/username and password, open **Profile**, then select **Add a passkey on this device**. To move to a replacement phone, first use the admin-issued temporary password on that device, set a new password, then register its passkey. The admin reset action removes that account’s registered passkeys before issuing the temporary password.

Admins manage their own passkey in **Settings → Passkey sign-in**. Password login remains available for every portal.

## Account recovery

If someone loses access to a device, an admin uses the existing **Reset password** action. This revokes registered passkeys for that account, creates a temporary password, and requires the user to choose a new password at the next sign-in. The user can then add a passkey on the replacement device.

Supabase describes JavaScript passkey support as experimental. Review the current [Supabase passkey guide](https://supabase.com/docs/guides/auth/passkeys) before enabling it in production.
