'use strict';

const browserSpecs = require('browser-specs');
const fetch = require('node-fetch');
const { Octokit } = require('@octokit/rest');
const { retry } = require("@octokit/plugin-retry");
const { throttling } = require("@octokit/plugin-throttling");
const MyOctokit = Octokit.plugin(throttling, retry);

const octokit = new MyOctokit({
  auth: process.env.GH_TOKEN,
  userAgent: 'past/spec-stats',
  throttle: {
    onRateLimit: (retryAfter, options, octokit) => {
      octokit.log.warn(`Request quota exhausted for request to ${options.url}`);
      octokit.log.warn(`Retry#${options.request.retryCount + 1} after ${retryAfter} seconds!`);
      return true;
    },
    onAbuseLimit: (retryAfter, options, octokit) => {
      // Don't retry, only log an error.
      octokit.log.warn(`Abuse detected for request to ${options.url}!`);
    },
  },
});

const SINCE = '2021-01-01T00:00:00Z';
const VENDORS = ['Apple', 'Google', 'Microsoft', 'Mozilla'];
const SPEC_DOMAIN = 'spec.whatwg.org/';
const WHATWG_ENTITIES = 'https://raw.githubusercontent.com/whatwg/participant-data/main/entities.json';
const responseTimes = new Map();
const vendorMembers = new Map();
const UNKNOWN_ORG = "unaffiliated";

function listRepositories() {
  const repoSet = new Set();
  for (const spec of browserSpecs) {
    if (spec.nightly.url.endsWith(SPEC_DOMAIN)) {
      repoSet.add(spec.nightly.repository);
    }
  }
  const repos = Array.from(repoSet);
  repos.sort();
  return repos;
}

function optionsFromURL(url) {
  url = new URL(url);
  if (url.hostname !== 'github.com') {
    return null;
  }

  const parts = url.pathname.split('/').filter((s) => s);
  if (parts.length !== 2) {
    return null;
  }
  return {owner: parts[0], repo: parts[1]};
}

// gets all issues since |SINCE| with pagination
function listIssues(options) {
  const listOptions = octokit.issues.listForRepo.endpoint.merge({
    ...options,
    since: SINCE,
  });
  return octokit.paginate(listOptions);
}

function listEvents(options, issue) {
  const listOptions = octokit.issues.listEventsForTimeline.endpoint.merge({
    ...options,
    issue_number: issue.number,
  });
  return octokit.paginate(listOptions);
}

async function getVendorMember(username, vendors) {
  if (vendorMembers.has(username)) {
    return vendorMembers.get(username);
  }
  for (const org of vendors) {
    try {
      await octokit.orgs.checkMembershipForUser({ org, username });
      vendorMembers.set(username, org);
      return org;
    } catch (e) { /* Ignore */ }
  }
  vendorMembers.set(username, UNKNOWN_ORG);
  return UNKNOWN_ORG;
}

function getVendorMap() {
  return fetch(WHATWG_ENTITIES).then(resp => resp.json()).then(entities => {
    const map = new Map();
    for (const vendor of VENDORS) {
      for (const entity of entities) {
        if (entity.info.name.startsWith(vendor)) {
          map.set(entity.info.gitHubOrganization, vendor);
          break;
        }
      }
    }
    map.set(UNKNOWN_ORG, UNKNOWN_ORG);
    return map;
  });
}

function addDelay(org, delay) {
  if (!responseTimes.has(org)) {
    responseTimes.set(org, []);
  }
  const delays = responseTimes.get(org);
  delays.push(delay);
}

async function main() {
  const repos = listRepositories();

  // Get the GH orgs for the vendors.
  const vendorOrgs = await getVendorMap();

  for (const repo of repos) {
    const options = optionsFromURL(repo);
    if (!options) {
      console.warn(`Unable to parse GitHub repo from URL: ${repo}`);
      continue;
    }

    const issues = await listIssues(options);
    for (const issue of issues) {
      // Only users from browser vendors count.
      const vendor = await getVendorMember(issue.user.login, vendorOrgs.keys());
      if (!vendor) {
        continue;
      }
      const events = await listEvents(options, issue);
      const firstInterestingEvent = events.find((event) => {
        // Ignore events that don't have a timestamp.
        if (!event.created_at) {
          return false;
        }
        // Activity from bots doesn't count.
        if (event.actor.type !== 'User') {
          return false;
        }
        // Activity from the issue creator doesn't count.
        if (event.actor.login === issue.user.login) {
          return false;
        }

        return true;
      });
      if (firstInterestingEvent) {
        const t0 = Date.parse(issue.created_at);
        const t1 = Date.parse(firstInterestingEvent.created_at);
        const delay = Math.round((t1 - t0) / (24 * 3600 * 1000));
        addDelay(vendor, delay);
        console.log(issue.html_url, `first activity after ${delay} day(s)`);
      } else {
        console.log(issue.html_url, 'no activity');
      }
    }
  }

  // Display the average delay per vendor.
  for (const vendor of responseTimes.keys()) {
    const times = responseTimes.get(vendor);
    const vendorAvgDelay = Math.floor(times.reduce((a, b) => a + b) / times.length);
    console.log(`Average delay for ${vendorOrgs.get(vendor)} issues is ${vendorAvgDelay} days`);
  }
  // Display the total average delay.
  let totalTimes = [];
  for (const times of responseTimes.values()) {
    totalTimes = totalTimes.concat(times);
  }
  const totalAvgDelay = Math.floor(totalTimes.reduce((a, b) => a + b) / totalTimes.length);
  console.log(`Total average delay is ${totalAvgDelay} days`);
  // Display vendor membership stats.
  const vendorStats = new Map();
  for (const entry of vendorMembers.entries()) {
    if (!vendorStats.has(entry[1])) {
      vendorStats.set(entry[1], []);
    }
    vendorStats.get(entry[1]).push(entry[0]);
  }
  for (const vendor of vendorStats.keys()) {
    console.log(`${vendorOrgs.get(vendor)} has ${vendorStats.get(vendor).length} members`);
    console.log(vendorStats.get(vendor));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
