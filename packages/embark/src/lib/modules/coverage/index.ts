import * as globule from "globule";
import * as path from "path";
import Web3Contract from "web3/eth/contract";

import { Contract, Embark } from "embark";
import { removePureView } from "../../utils/solidity/code";
import { ContractEnhanced } from "./contractEnhanced";
import { coverageContractsPath } from "./path";
import { Coverage as ICoverage } from "./types";

export default class Coverage {
  private contracts: ContractEnhanced[];
  private deployedContracts: Contract[] = [];
  private web3Contracts: Web3Contract[] = [];
  private contractsDir: string[] = [];
  private fs: any;

  constructor(private embark: Embark, options: any) {
    this.fs = embark.fs;
    this.fs.ensureDirSync(coverageContractsPath());
    const contractsDirConfig = this.embark.config.embarkConfig.contracts;
    this.contractsDir = Array.isArray(contractsDirConfig) ? contractsDirConfig : [contractsDirConfig];

    this.contracts = this.getContracts();

    this.embark.events.setCommandHandler("coverage:prepareContracts", async (done) => {
      await this.prepareContracts();
      this.swapContracts();
      done();
    });

    this.embark.events.on("tests:ready", this.pushDeployedContracts.bind(this));
    this.embark.events.on("tests:finished", this.produceCoverageReport.bind(this));
    this.embark.events.on("tests:manualDeploy", this.registerWeb3Contract.bind(this));
  }

  private getContracts() {
    const solcVersion = this.embark.config.embarkConfig.versions.solc;
    const filepaths = this.contractsDir.reduce((acc: string[], pattern: string) => (
      acc.concat(globule.find(pattern, { prefixBase: false, srcBase: this.fs.dappPath() }))
    ), []);

    return filepaths.filter((filepath) => this.fs.statSync(filepath).isFile())
                    .map((filepath) => new ContractEnhanced(filepath, solcVersion));
  }

  private async prepareContracts() {
    const promises = this.contracts.map(async (contract) => {
      contract.instrument();
      contract.save();
    });
    await Promise.all(promises);
    removePureView(coverageContractsPath());
  }

  private swapContracts() {
    this.embark.config.embarkConfig.contracts = this.contractsDir.reduce((acc: string[], value: string) => (
      acc.concat(path.join(coverageContractsPath(), value))
    ), []);
    this.embark.config.contractsFiles = [];
    this.embark.config.reloadConfig();
  }

  private async pushDeployedContracts() {
    const newContracts = await this.getDeployedContracts();
    this.deployedContracts = this.deployedContracts.concat(newContracts);
  }

  private async produceCoverageReport(cb: () => void) {
    const web3Contracts = await this.getWeb3Contracts();
    await Promise.all(this.collectEvents(web3Contracts));
    this.writeCoverageReport(cb);
  }

  private writeCoverageReport(cb: () => void) {
    this.fs.ensureDirSync(path.join(this.fs.dappPath(), ".embark"));
    const coveragePath = path.join(this.fs.dappPath(), ".embark", "coverage.json");

    const coverageReport = this.contracts.reduce((acc: {[name: string]: ICoverage}, contract) => {
      acc[contract.filepath] = contract.coverage;
      return acc;
    }, {});

    this.fs.writeFile(coveragePath, JSON.stringify(coverageReport, null, 2), cb);
  }

  private collectEvents(web3Contracts: Web3Contract[]) {
    return web3Contracts.map(async (web3Contract) => {
      const events = await web3Contract.getPastEvents("allEvents", {fromBlock: 0});
      this.contracts.forEach((contract) => contract.updateCoverage(events));
    });
  }

  private getWeb3Contract(deployedContract: Contract) {
    return new Promise<Web3Contract>((resolve) => {
      const address = deployedContract.deployedAddress;
      const abi = deployedContract.abiDefinition;
      this.embark.events.request("blockchain:contract:create", {address, abi}, (web3Contract: Web3Contract) => {
        resolve(web3Contract);
      });
    });
  }

  private getDeployedContracts() {
    return new Promise<Contract[]>((resolve, reject) => {
      this.embark.events.request("contracts:all", (error: Error, contracts: {[name: string]: Contract}) => {
        if (error) {
          return reject(error);
        }
        resolve(Object.values(contracts));
      });
    });
  }

  private async getWeb3Contracts() {
    const web3Contracts = this.deployedContracts.filter((deployedContract) => deployedContract.deployedAddress)
                                                .map((deployedContract) => this.getWeb3Contract(deployedContract));

    return (await Promise.all(web3Contracts)).concat(this.web3Contracts);
  }

  private registerWeb3Contract(web3Contract: Web3Contract) {
    this.web3Contracts.push(web3Contract);
  }
}
