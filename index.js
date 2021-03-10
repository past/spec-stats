'use strict';

const browserSpecs = require('browser-specs');
const {Octokit} = require('@octokit/rest');

const octokit = new Octokit({
  auth: process.env.GH_TOKEN,
});

const SINCE = '2021-01-01T00:00:00Z';

function listRepositories() {
  const repoSet = new Set();
  for (const spec of browserSpecs) {
    repoSet.add(spec.nightly.repository);
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

async function main() {
  const repos = listRepositories();

  for (const repo of repos) {
    const options = optionsFromURL(repo);
    if (!options) {
      console.warn(`Unable to parse GitHub repo from URL: ${repo}`);
      continue;
    }

    const issues = await listIssues(options);
    for (const issue of issues) {
      // TODO: measure something about each issue. Potentially interesting:

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
        // TODO: filter to only repo maintainers, but how?
        return true;
      });
      if (firstInterestingEvent) {
        const t0 = Date.parse(issue.created_at);
        const t1 = Date.parse(firstInterestingEvent.created_at);
        const delay = Math.round((t1 - t0) / (24 * 3600 * 1000));
        console.log(issue.html_url, `first activity after ${delay} day(s)`);
      } else {
        console.log(issue.html_url, 'no activity');
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
