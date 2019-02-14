let async = require('async');
const utils = require('../../utils/utils.js');
const constants = require('../../constants');

require('ejs');
const Templates = {
  vanilla_contract: require('./code_templates/vanilla-contract.js.ejs'),
  embarkjs_contract: require('./code_templates/embarkjs-contract.js.ejs'),
  exec_when_ready: require('./code_templates/exec-when-ready.js.ejs'),
  load_manager: require('./code_templates/load-manager.js.ejs'),
  define_when_env_loaded: require('./code_templates/define-when-env-loaded.js.ejs'),
  main_context: require('./code_templates/main-context.js.ejs'),
  do_when_loaded: require('./code_templates/do-when-loaded.js.ejs'),
  exec_when_env_loaded: require('./code_templates/exec-when-env-loaded.js.ejs')
};

class CodeGenerator {
  constructor(embark, options) {
    this.blockchainConfig = embark.config.blockchainConfig || {};
    this.embarkConfig = embark.config.embarkConfig;
    this.fs = embark.fs;
    this.dappConfigs = {};
    this.logger = embark.logger;
    this.rpcHost = this.blockchainConfig.rpcHost || '';
    this.rpcPort = this.blockchainConfig.rpcPort || '';
    this.contractsConfig = embark.config.contractsConfig || {};
    this.storageConfig = embark.config.storageConfig || {};
    this.communicationConfig = embark.config.communicationConfig || {};
    this.namesystemConfig = embark.config.namesystemConfig || {};
    this.webServerConfig = embark.config.webServerConfig || {};
    this.env = options.env || 'development';
    this.plugins = options.plugins;
    this.events = embark.events;

    this.listenToCommands();

    const self = this;
    this.events.setCommandHandler("code-generator:embarkjs:build", (cb) => {
      self.buildEmbarkJS(cb);
    });
  }

  listenToCommands() {
    this.events.on('config:load:contracts', this.generateContractConfig.bind(this));
    this.events.on('config:load:storage', this.generateStorageConfig.bind(this));
    this.events.on('config:load:communication', this.generateCommunicationConfig.bind(this));

    this.events.setCommandHandler('code', (cb) => {
      this.events.request("contracts:list", (_err, contractsList) => {
        let embarkJSABI = this.generateABI(contractsList, {useEmbarkJS: true});
        let contractsJSON = this.generateContractsJSON(contractsList);
        cb(embarkJSABI, contractsJSON);
      });
    });

    this.events.setCommandHandler('code-generator:contract', (contractName, cb) => {
      this.events.request('contracts:contract', contractName, (contract) => {
        this.buildContractJS(contractName, this.generateContractJSON(contract, contract), cb);
      });
    });

    this.events.setCommandHandler('code-generator:contract:vanilla', (contract, gasLimit, cb) => {
      cb(this.generateContractCode(contract, gasLimit));
    });

    this.events.setCommandHandler('code-generator:contract:custom', (contract, cb) => {
      const customCode = this.generateCustomContractCode(contract);
      if (!customCode) {
        // Fallback to generate code from vanilla contract generator.
        //
        // TODO: can be moved into a afterDeploy event
        // just need to figure out the gasLimit coupling issue
        return cb(this.generateContractCode(contract, contract._gasLimit || false));
      }
      cb(customCode);
    });

    this.events.setCommandHandler('code-generator:embarkjs:provider-code', (cb) => {
      cb(this.getEmbarkJsProviderCode());
    });

    this.events.setCommandHandler('code-generator:embarkjs:init-provider-code', (cb) => {
      cb(this.getInitProviderCode());
    });
  }

  generateContracts(contractsList, useEmbarkJS, isDeployment, useLoader) {
    let self = this;
    let result = "\n";
    let contractsPlugins;

    if (useLoader === false) {
      for (let contract of contractsList) {
        let abi = JSON.stringify(contract.abiDefinition);
        result += Templates.vanilla_contract({className: contract.className, abi: abi, contract: contract, gasLimit: constants.codeGenerator.gasLimit});
      }
      return result;
    }

    if (self.blockchainConfig === {} || self.blockchainConfig.enabled === false) {
      return "";
    }

    if (this.plugins) {
      contractsPlugins = this.plugins.getPluginsFor('contractGeneration');
    }

    if (this.plugins && contractsPlugins.length > 0) {
      contractsPlugins.forEach(function (plugin) {
        result += plugin.generateContracts({contracts: contractsList});
      });
    } else {
      for (let contract of contractsList) {
        let abi = JSON.stringify(contract.abiDefinition);
        let gasEstimates = JSON.stringify(contract.gasEstimates);

        let block = "";

        if (useEmbarkJS) {
           let contractAddress = contract.deployedAddress ? ("'" + contract.deployedAddress + "'") : "undefined";
          block += Templates.embarkjs_contract({className: contract.className, abi: abi, contract: contract, contractAddress: contractAddress, gasEstimates: gasEstimates});
        } else {
          block += Templates.vanilla_contract({className: contract.className, abi: abi, contract: contract, gasLimit: (isDeployment ? constants.codeGenerator.gasLimit : false)});
        }
        result += Templates.exec_when_ready({block: block});

      }
    }

    return result;
  }

  checkIfNeedsUpdate(file, newOutput, callback) {
    this.fs.readFile(file, (err, content) => {
      if (err) {
        return callback(null, true);
      }
      callback(null, content.toString() !== newOutput);
    });
  }

  generateContractConfig(contractConfig) {
    this.dappConfigs.blockchain = {
      dappConnection: contractConfig.dappConnection,
      dappAutoEnable: contractConfig.dappAutoEnable,
      warnIfMetamask: this.blockchainConfig.isDev,
      blockchainClient: this.blockchainConfig.ethereumClientName
    };
    this.generateArtifact(this.dappConfigs.blockchain, constants.dappConfig.blockchain, constants.dappConfig.dir);
  }

  generateStorageConfig(storageConfig) {
    this.dappConfigs.storage = {
      dappConnection: storageConfig.dappConnection
    };
    this.generateArtifact(this.dappConfigs.storage, constants.dappConfig.storage, constants.dappConfig.dir);
  }

  generateCommunicationConfig(communicationConfig) {
    this.dappConfigs.communication = {
      connection: communicationConfig.connection
    };
    this.generateArtifact(this.dappConfigs.communication, constants.dappConfig.communication, constants.dappConfig.dir);
  }

  generateArtifact(artifactInput, fileName, dirName, cb = () => {}) {
    const dir = utils.joinPath(this.embarkConfig.generationDir, dirName);
    const filePath = utils.joinPath(dir, fileName);
    if (typeof artifactInput !== 'string') {
      artifactInput = JSON.stringify(artifactInput, null, 2);
    }
    async.waterfall([
      (next) => {
        this.fs.mkdirp(dir, next);
      },
      (_dir, next) => {
        this.checkIfNeedsUpdate(filePath, artifactInput, next);
      },
      (needsUpdate, next) => {
        if (!needsUpdate) {
          return next();
        }
        this.fs.writeFile(filePath, artifactInput, next);
      }
    ], (err) => {
      if (err) {
        this.logger.error(err.message || err);
      }
      cb(err, filePath);
    });
  }

  generateContractCode(contract, gasLimit) {
    let abi = JSON.stringify(contract.abiDefinition);

    let block = "";
    block += Templates.vanilla_contract({className: contract.className, abi: abi, contract: contract, gasLimit: gasLimit});
    return block;
  }


  generateCustomContractCode(contract) {
    const customContractGeneratorPlugin = this.plugins.getPluginsFor('customContractGeneration').splice(-1)[0];
    if (!customContractGeneratorPlugin) {
      return null;
    }
    return customContractGeneratorPlugin.generateCustomContractCode(contract);
  }

  generateNamesInitialization(useEmbarkJS) {
    if (!useEmbarkJS || this.namesystemConfig === {}) return "";

    let result = "\n";
    result += Templates.define_when_env_loaded();
    result += this._getInitCode('names', this.namesystemConfig);

    return result;
  }

  generateStorageInitialization(useEmbarkJS) {
    if (!useEmbarkJS || this.storageConfig === {}) return "";

    let result = "\n";
    result += Templates.define_when_env_loaded();
    result += this._getInitCode('storage', this.storageConfig);

    return result;
  }

  generateCommunicationInitialization(useEmbarkJS) {
    if (!useEmbarkJS || this.communicationConfig === {}) return "";

    let result = "\n";
    result += Templates.define_when_env_loaded();
    result += this._getInitCode('communication', this.communicationConfig);

    return result;
  }

   _getInitCode(codeType, config) {
    let result = "";
    let pluginsWithCode = this.plugins.getPluginsFor('initCode');
    for (let plugin of pluginsWithCode) {
      let initCodes = plugin.embarkjs_init_code[codeType] || [];
      for (let initCode of initCodes) {
        let [block, shouldInit] = initCode;
        if (shouldInit.call(plugin, config)) {
          result += Templates.exec_when_env_loaded({block: block});
        }
      }
    }
    return result;
  }

  generateABI(contractsList, options) {
    let result = "";

    result += this.generateContracts(contractsList, options.useEmbarkJS, options.deployment, true);
    result += this.generateStorageInitialization(options.useEmbarkJS);
    result += this.generateCommunicationInitialization(options.useEmbarkJS);
    result += this.generateNamesInitialization(options.useEmbarkJS);

    return result;
  }

  generateContractJSON(className, contract) {
    let contractJSON = {};

    contractJSON.contract_name = className;
    contractJSON.address = contract.deployedAddress;
    contractJSON.code = contract.code;
    contractJSON.runtime_bytecode = contract.runtimeBytecode;
    contractJSON.real_runtime_bytecode = contract.realRuntimeBytecode;
    contractJSON.swarm_hash = contract.swarmHash;
    contractJSON.gas_estimates = contract.gasEstimates;
    contractJSON.function_hashes = contract.functionHashes;
    contractJSON.abi = contract.abiDefinition;

    return contractJSON;
  }

  generateContractsJSON(contractsList) {
    let contracts = {};

    for (let contract of contractsList) {
      contracts[contract.className] = this.generateContractJSON(contract.className, contract);
    }

    return contracts;
  }

  buildEmbarkJS(cb) {
    const self = this;
    let embarkjsCode = "import EmbarkJS from 'embarkjs';";
    embarkjsCode += "\nexport default EmbarkJS;";
    embarkjsCode += "\nglobal.EmbarkJS = EmbarkJS";
    let code = "/* eslint-disable */";

    async.waterfall([
      function getJSCode(next) {
        code += "\n" + embarkjsCode + "\n";

        code += self.getEmbarkJsProviderCode();
        code += self.generateCommunicationInitialization(true);
        code += self.generateStorageInitialization(true);
        code += self.generateNamesInitialization(true);
        code += self.getReloadPageCode();
        code += '\n/* eslint-enable */';

        next();
      },
      function writeFile(next) {
        self.generateArtifact(code, constants.dappConfig.embarkjs, '', next);
      }
    ], function(_err, _result) {
      cb();
    });
  }

  getReloadPageCode() {
    return this.env === 'development' ? this.fs.readFileSync(require('path').join(__dirname,'/code/reload-on-change.js'), 'utf8') : '';
  }

  getEmbarkJsProviderCode() {
    return this.plugins.getPluginsFor('embarkjsCode').reduce((code, plugin) => (
      code += plugin.embarkjs_code.join('\n')
    ), '');
  }

  getInitProviderCode() {
    const codeTypes = {
      blockchain: this.blockchainConfig || {},
      communication: this.communicationConfig || {},
      names: this.namesystemConfig || {},
      storage: this.storageConfig || {}
    };

    return this.plugins.getPluginsFor("initConsoleCode").reduce((acc, plugin) => {
      Object.keys(codeTypes).forEach((codeTypeName) => {
        (plugin.embarkjs_init_console_code[codeTypeName] || []).forEach((initCode) => {
          const [block, shouldInit] = initCode;
          if (shouldInit.call(plugin, codeTypes[codeTypeName])) {
            acc += block;
          }
        });
      });
      return acc;
    }, "");
  }

  buildContractJS(contractName, contractJSON, cb) {
    let contractCode = "import EmbarkJS from '../embarkjs';\n";
    contractCode += `let ${contractName}JSONConfig = ${JSON.stringify(contractJSON)};\n`;
    contractCode += `let ${contractName} = new EmbarkJS.Blockchain.Contract(${contractName}JSONConfig);\n`;

    contractCode += "export default " + contractName + ";\n";

    this.generateArtifact(contractCode, contractName + '.js', constants.dappConfig.contractsJs, cb);
  }
}

module.exports = CodeGenerator;
