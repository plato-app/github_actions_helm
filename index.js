const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const util = require("util");
const Mustache = require("mustache");

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const required = { required: true };

/**
 * Status marks the deployment status. Only activates if token is set as an
 * input to the job.
 *
 * @param {string} state
 */
async function status(state) {
  try {
    const context = github.context;
    const deployment = context.payload.deployment;
    const token = core.getInput("token");
    if (!token || !deployment) {
      core.debug("not setting deployment status");
      return;
    }

    const client = new github.GitHub(token);
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/commit/${context.sha}/checks`;

    await client.repos.createDeploymentStatus({
      ...context.repo,
      deployment_id: deployment.id,
      state,
      log_url: url,
      target_url: url,
      headers: {
        accept: 'application/vnd.github.ant-man-preview+json'
      }
    });
  } catch (error) {
    core.warning(`Failed to set deployment status: ${error.message}`);
  }
}

function releaseName(name, track) {
  if (track !== "stable") {
    return `${name}-${track}`;
  }
  return name;
}

function chartName(name) {
  if (name === "app") {
    return "/usr/src/charts/app";
  }
  return name;
}

function getValues(values) {
  if (!values) {
    return "{}";
  }
  if (typeof values === "object") {
    return JSON.stringify(values);
  }
  return values;
}

function getSecrets(secrets) {
  if (typeof secrets === "string") {
    try {
      return JSON.parse(secrets);
    } catch (err) {
      return secrets;
    }
  }
  return secrets;
}

function getValueFiles(files) {
  let fileList;
  if (typeof files === "string") {
    try {
      fileList = JSON.parse(files);
    } catch (err) {
      // Assume it's a single string.
      fileList = [files];
    }
  } else {
    fileList = files;
  }
  if (!Array.isArray(fileList)) {
    return [];
  }
  return fileList.filter(f => !!f);
}

function getInput(name, options) {
  const context = github.context;
  const deployment = context.payload.deployment;
  let val = core.getInput(name.replace("_", "-"), {
    ...options,
    required: false
  });
  if (deployment) {
    if (deployment[name]) val = deployment[name];
    if (deployment.payload[name]) val = deployment.payload[name];
  }
  if (options && options.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return val;
}

/**
 * Render files renders data into the list of provided files.
 * @param {Array<string>} files
 * @param {any} data
 */
function renderFiles(files, data) {
  core.debug(
    `rendering value files [${files.join(",")}] with: ${JSON.stringify(data)}`
  );
  const tags = ["${{", "}}"];
  const promises = files.map(async file => {
    const content = await readFile(file, { encoding: "utf8" });
    const rendered = Mustache.render(content, data, {}, tags);
    await writeFile(file, rendered);
  });
  return Promise.all(promises);
}

/**
 * Makes a delete command for compatibility between helm 2 and 3.
 *
 * @param {string} helm
 * @param {string} namespace
 * @param {string} release
 */
function deleteCmd(helm, namespace, release) {
  if (helm === "helm3") {
    return ["delete", "-n", namespace, release];
  }
  return ["delete", "--purge", release];
}

/**
 * Run executes the helm deployment.
 */
async function run() {
  try {
    const context = github.context;
    await status("pending");

    const track = getInput("track") || "stable";
    const appName = getInput("release", required);
    const release = releaseName(appName, track);
    const namespace = getInput("namespace", required);
    const chart = chartName(getInput("chart", required));
    const chartVersion = getInput("chart_version");
    const values = getValues(getInput("values"));
    const task = getInput("task");
    const version = getInput("version");
    const valueFiles = getValueFiles(getInput("value_files"));
    const removeCanary = getInput("remove_canary");
    const helm = "helm";
    const timeout = getInput("timeout");
    const repository = getInput("repository");
    const repositoryUsername = getInput("repository_username");
    const repositoryPassword = getInput("repository_password");
    const dryRun = core.getInput("dry-run");
    const secrets = getSecrets(core.getInput("secrets"));
    const atomic = getInput("atomic") || true;
    const schemaLocation = getInput("schema_location");

    core.debug(`param: track = "${track}"`);
    core.debug(`param: release = "${release}"`);
    core.debug(`param: appName = "${appName}"`);
    core.debug(`param: namespace = "${namespace}"`);
    core.debug(`param: chart = "${chart}"`);
    core.debug(`param: chart_version = "${chartVersion}"`);
    core.debug(`param: values = "${values}"`);
    core.debug(`param: dryRun = "${dryRun}"`);
    core.debug(`param: task = "${task}"`);
    core.debug(`param: version = "${version}"`);
    core.debug(`param: secrets = "${JSON.stringify(secrets)}"`);
    core.debug(`param: valueFiles = "${JSON.stringify(valueFiles)}"`);
    core.debug(`param: removeCanary = ${removeCanary}`);
    core.debug(`param: timeout = "${timeout}"`);
    core.debug(`param: repository = "${repository}"`);
    core.debug(`param: repository_username = "${repositoryUsername}"`);
    core.debug(`param: repository_password = "${repositoryPassword}"`);
    core.debug(`param: atomic = "${atomic}"`);
    core.debug(`parma: schema_location = "${schemaLocation}"`);


    // Setup command options and arguments.
    const args = [
      "upgrade",
      release,
      chart,
      "--install",
      "--wait",
      `--namespace=${namespace}`,
    ];

    const diffArgs = [
      "diff",
      "upgrade",
      release,
      chart,
      `--namespace=${namespace}`,
      "--allow-unreleased",
      "--context=2",
      "--find-renames=0.5",
    ];

    const kubevalArgs = [
      "kubeval",
      "--schema-location",
      "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master",
      chart,
      `--namespace=${namespace}`,
    ]

    if (schemaLocation) {
      kubevalArgs[2] = `${schemaLocation}`
    }

    process.env.XDG_DATA_HOME = "/root/.local/share"
    process.env.XDG_CACHE_HOME = "/root/.cache"
    process.env.XDG_CONFIG_HOME = "/root/.config"
  
    if (String(dryRun) === "true") args.push("--dry-run");
    if (appName) {
      args.push(`--set=app.name=${appName}`);
      diffArgs.push(`--set=app.name=${appName}`);
      kubevalArgs.push(`--set=app.name=${appName}`);
    }
    if (version) {
      args.push(`--set=app.version=${version}`);
      diffArgs.push(`--set=app.version=${version}`);
      kubevalArgs.push(`--set=app.version=${version}`);
    }
    if (chartVersion) {
      args.push(`--version=${chartVersion}`);
      diffArgs.push(`--version=${chartVersion}`);
      kubevalArgs.push(`--version=${chartVersion}`);
    }
    if (timeout) args.push(`--timeout=${timeout}`);
    if (repository) {
      args.push(`--repo=${repository}`);
      diffArgs.push(`--repo=${repository}`);
      kubevalArgs.push(`--repo=${repository}`);
    }
    if (repositoryUsername) {
      args.push(`--username=${repositoryUsername}`);
      diffArgs.push(`--username=${repositoryUsername}`);
      kubevalArgs.push(`--username=${repositoryUsername}`);
    }
    if (repositoryPassword) {
      args.push(`--password=${repositoryPassword}`);
      diffArgs.push(`--password=${repositoryPassword}`);
      kubevalArgs.push(`--password=${repositoryPassword}`);
    }
    valueFiles.forEach(f => {
      args.push(`--values=${f}`)
      diffArgs.push(`--values=${f}`)
      kubevalArgs.push(`--values=${f}`)
    });

    args.push("--values=./values.yml");
    diffArgs.push("--values=./values.yml");
    kubevalArgs.push("--values=./values.yml");

    // Special behaviour is triggered if the track is labelled 'canary'. The
    // service and ingress resources are disabled. Access to the canary
    // deployments can be routed via the main stable service resource.
    if (track === "canary") {
      args.push("--set=service.enabled=false", "--set=ingress.enabled=false");
    }

    // If true upgrade process rolls back changes made in case of failed upgrade.
    if (atomic === true) {
      args.push("--atomic");
    }

    // Setup necessary files.
    if (process.env.KUBECONFIG_FILE) {
      process.env.KUBECONFIG = "./kubeconfig.yml";
      await writeFile(process.env.KUBECONFIG, process.env.KUBECONFIG_FILE);
      fs.chmodSync(process.env.KUBECONFIG, 0600);
    }

    await writeFile("./values.yml", values);

    core.debug(`env: KUBECONFIG="${process.env.KUBECONFIG}"`);

    // Render value files using github variables.
    await renderFiles(valueFiles.concat(["./values.yml"]), {
      secrets,
      deployment: context.payload.deployment,
    });

    // Remove the canary deployment before continuing.
    if (removeCanary) {
      core.debug(`removing canary ${appName}-canary`);
      await exec.exec(helm, deleteCmd(helm, namespace, `${appName}-canary`), {
        ignoreReturnCode: true
      });
    }

    await exec.exec(helm, [ "env" ]);

    const execHelmToFile = async function (helmArgs, fileName) {
      let diffOutput = '';

      const options = {};
      options.listeners = {
        stdout: (data) => {
          diffOutput += data.toString();
        }
      };

      try
      {
        await exec.exec(helm, helmArgs, options);
      } finally {
        fs.appendFileSync(fileName, diffOutput)
        fs.appendFileSync(process.env['GITHUB_OUTPUT'], `file=${fileName}${os.EOL}`)
      }
    }

    // Actually execute the deployment here.
    if (task === "remove") {
      await exec.exec(helm, deleteCmd(helm, namespace, release), {
        ignoreReturnCode: true
      });
    } else if (task === "diff" ) {
      await execHelmToFile(diffArgs, "helm-diff.out")
    } else if (task === "kubeval" ) {
      await execHelmToFile(kubevalArgs, "kubeval-diff.out")
    } else {
      await exec.exec(helm, args);
    }

    await status(task === "remove" ? "inactive" : "success");
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
    await status("failure");
  }
}

run();
