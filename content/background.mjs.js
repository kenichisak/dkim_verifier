/**
 * Copyright (c) 2020 Philippe Lieser
 *
 * This software is licensed under the terms of the MIT License.
 *
 * The above copyright and license notice shall be
 * included in all copies or substantial portions of the Software.
 */

// @ts-check
///<reference path="../WebExtensions.d.ts" />
///<reference path="../experiments/dkimHeader.d.ts" />
/* eslint-env browser, webextensions */

import { DKIM_InternalError, DKIM_SigError } from "../modules/error.mjs.js";
import AuthVerifier from "../modules/AuthVerifier.mjs.js";
import DNS from "../modules/dns.mjs.js";
import Logging from "../modules/logging.mjs.js";
import { migratePrefs } from "../modules/migration.mjs.js";
import prefs from "../modules/preferences.mjs.js";
import { setKeyFetchFunction } from "../modules/dkim/verifier.mjs.js";

const log = Logging.getLogger("background");

async function init() {
	await prefs.init();

	if (prefs.debug) {
		/** @type {number|undefined} */
		// @ts-ignore
		let logLevel = Logging.Level[prefs["logging.console"]];
		if (!logLevel) {
			logLevel = Logging.Level.Debug;
		}
		Logging.setLogLevel(logLevel);
	}

	await migratePrefs();
}
const isInitialized = init();
isInitialized.catch(error => log.fatal("Initializing failed with:", error));

// eslint-disable-next-line valid-jsdoc
/** @type {import("../modules/dkim/verifier.mjs.js").KeyFetchFunction} */
async function getKey(sdid, selector) {
	const dnsRes = await DNS.txt(`${selector}._domainkey.${sdid}`);

	if (dnsRes.bogus) {
		throw new DKIM_InternalError(null, "DKIM_DNSERROR_DNSSEC_BOGUS");
	}
	if (dnsRes.rcode !== DNS.RCODE.NoError && dnsRes.rcode !== DNS.RCODE.NXDomain) {
		log.info("DNS query failed with result:", dnsRes);
		throw new DKIM_InternalError(`rcode: ${dnsRes.rcode}`,
			"DKIM_DNSERROR_SERVER_ERROR");
	}
	if (dnsRes.data === null || dnsRes.data[0] === "") {
		throw new DKIM_SigError("DKIM_SIGERROR_NOKEY");
	}

	if (!dnsRes.data) {
		throw new DKIM_SigError("DKIM_SIGERROR_NOKEY");
	}
	return {
		key: dnsRes.data[0],
		secure: false,
	};
}

setKeyFetchFunction(getKey);

const SHOW = {
	NEVER: 0,
	DKIM_VALID: 10,
	DKIM_VALID_ALL: 20,
	DKIM_SIGNED: 30,
	EMAIL: 40,
	MSG: 50,
};

browser.messageDisplay.onMessageDisplayed.addListener(async (tab, message) => {
	try {
		await isInitialized;

		// return if msg is RSS feed or news
		const account = await browser.accounts.get(message.folder.accountId);
		if (account && (account.type === "rss" || account.type === "nntp")) {
			browser.dkimHeader.showDkimHeader(tab.id, prefs.showDKIMHeader >= SHOW.MSG);
			browser.dkimHeader.setDkimHeaderResult(
				tab.id, browser.i18n.getMessage("NOT_EMAIL"), [], "");
			return;
		}

		// If we already know if the header should be shown, trigger it now
		if (prefs.showDKIMHeader >= SHOW.EMAIL) {
			browser.dkimHeader.showDkimHeader(tab.id, true);
		}
		else {
			const { headers } = await browser.messages.getFull(message.id);
			if (headers && Object.keys(headers).includes("dkim-signature")) {
				if (prefs.showDKIMHeader >= SHOW.DKIM_SIGNED) {
					browser.dkimHeader.showDkimHeader(tab.id, true);
				}
			}
		}

		const rawMessage = await browser.messages.getRaw(message.id);
		const verifier = new AuthVerifier();
		const res = await verifier.verify(rawMessage);
		const warnings = res.dkim[0].warnings_str || [];

		browser.dkimHeader.showDkimHeader(tab.id, prefs.showDKIMHeader >= res.dkim[0].res_num);
		await browser.dkimHeader.setDkimHeaderResult(tab.id, res.dkim[0].result_str, warnings, res.dkim[0].favicon || "");
		if (prefs.colorFrom) {
			switch (res.dkim[0].res_num) {
				case AuthVerifier.DKIM_RES.SUCCESS: {
					const dkim = res.dkim[0];
					if (!dkim.warnings_str || dkim.warnings_str.length === 0) {
						browser.dkimHeader.highlightFromAddress(tab.id, prefs["color.success.text"], prefs["color.success.background"]);
					} else {
						browser.dkimHeader.highlightFromAddress(tab.id, prefs["color.warning.text"], prefs["color.warning.background"]);
					}
					break;
				}
				case AuthVerifier.DKIM_RES.TEMPFAIL:
					browser.dkimHeader.highlightFromAddress(tab.id, prefs["color.tempfail.text"], prefs["color.tempfail.background"]);
					break;
				case AuthVerifier.DKIM_RES.PERMFAIL:
					browser.dkimHeader.highlightFromAddress(tab.id, prefs["color.permfail.text"], prefs["color.permfail.background"]);
					break;
				case AuthVerifier.DKIM_RES.PERMFAIL_NOSIG:
				case AuthVerifier.DKIM_RES.NOSIG:
					browser.dkimHeader.highlightFromAddress(tab.id, prefs["color.nosig.text"], prefs["color.nosig.background"]);
					break;
				default:
					throw new Error(`unknown res_num: ${res.dkim[0].res_num}`);
			}
		}
	} catch (e) {
		log.fatal("Unexpected error during onMessageDisplayed", e);
		browser.dkimHeader.showDkimHeader(tab.id, true);
		browser.dkimHeader.setDkimHeaderResult(
			tab.id, browser.i18n.getMessage("DKIM_INTERNALERROR_NAME"), [], "");
	}
});
