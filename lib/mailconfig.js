'use strict';
/**
 * lib/mailconfig.js — Generate mail client auto-configuration payloads
 *
 * Produces:
 *  • RFC 6186 Autoconfig XML  (Thunderbird / Apple Mail / most IMAP clients)
 *  • Microsoft Autodiscover XML (Outlook)
 *  • iOS .mobileconfig profile (Apple Mail on iPhone / iPad)
 */

const { randomBytes } = require('crypto');

// ── Helpers ───────────────────────────────────────────────────────────────────
function uuid4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20)].join('-');
}

// ── RFC 6186 autoconfig XML (Thunderbird / Mozilla / most clients) ────────────
function autoconfigXml(domain) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${domain}">
    <domain>${domain}</domain>
    <displayName>${domain} Mail</displayName>
    <displayShortName>${domain}</displayShortName>
    <incomingServer type="imap">
      <hostname>mail.${domain}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>mail.${domain}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
}

// ── Microsoft Autodiscover XML (Outlook) ──────────────────────────────────────
function autodiscoverXml(domain) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>mail.${domain}</Server>
        <Port>993</Port>
        <SSL>on</SSL>
        <LoginName>%EMAILADDRESS%</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>mail.${domain}</Server>
        <Port>587</Port>
        <SSL>off</SSL>
        <Encryption>TLS</Encryption>
        <LoginName>%EMAILADDRESS%</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;
}

// ── Autodiscover PHP handler (serves XML for both GET and POST from Outlook) ──
function autodiscoverPhp(domain) {
  return `<?php
header('Content-Type: application/xml; charset=utf-8');
readfile(__DIR__ . '/autodiscover.xml');
`;
}

// ── iOS / macOS .mobileconfig profile ────────────────────────────────────────
function mobileconfigPlist(domain, displayName) {
  const name = displayName || domain;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>EmailAccountDescription</key><string>${name} Mail</string>
      <key>EmailAccountName</key><string>${name}</string>
      <key>EmailAccountType</key><string>EmailTypeIMAP</string>
      <key>EmailAddress</key><string>user@${domain}</string>
      <key>IncomingMailServerHostName</key><string>mail.${domain}</string>
      <key>IncomingMailServerPortNumber</key><integer>993</integer>
      <key>IncomingMailServerUseSSL</key><true/>
      <key>IncomingMailServerUsername</key><string>user@${domain}</string>
      <key>OutgoingMailServerHostName</key><string>mail.${domain}</string>
      <key>OutgoingMailServerPortNumber</key><integer>587</integer>
      <key>OutgoingMailServerUseSSL</key><false/>
      <key>OutgoingMailServerUsername</key><string>user@${domain}</string>
      <key>OutgoingPasswordSameAsIncomingPassword</key><true/>
      <key>PayloadDescription</key><string>Email account configuration for ${domain}</string>
      <key>PayloadDisplayName</key><string>${name} Mail</string>
      <key>PayloadIdentifier</key><string>com.dpanel.mail.${domain}</string>
      <key>PayloadType</key><string>com.apple.mail.managed</string>
      <key>PayloadUUID</key><string>${uuid4()}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>SMIMEEnabled</key><false/>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Auto-configures email for ${domain}</string>
  <key>PayloadDisplayName</key><string>${name} Email Setup</string>
  <key>PayloadIdentifier</key><string>com.dpanel.mailprofile.${domain}</string>
  <key>PayloadOrganization</key><string>${domain}</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid4()}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>`;
}

module.exports = { autoconfigXml, autodiscoverXml, autodiscoverPhp, mobileconfigPlist };
