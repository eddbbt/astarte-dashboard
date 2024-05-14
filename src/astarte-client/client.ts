/*
   This file is part of Astarte.

   Copyright 2020-2021 Ispirata Srl

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

import axios from 'axios';
import { Channel, Socket } from 'phoenix';
import _ from 'lodash';
import { AstarteTriggerDeliveryPolicyDTO } from 'astarte-client/types/dto';

import {
  AstarteDataTreeNode,
  fromAstarteDeviceDTO,
  fromAstarteInterfaceDTO,
  toAstarteInterfaceDTO,
  fromAstartePipelineDTO,
  toAstartePipelineDTO,
  fromAstarteTriggerDTO,
  toAstarteTriggerDTO,
  toAstarteDataTree,
} from './transforms';
import * as definitions from './definitions';
import { AstarteCustomBlock, toAstarteBlock } from './models/Block';
import { AstarteDevice } from './models/Device';
import { AstarteFlow } from './models/Flow';
import { AstartePipeline } from './models/Pipeline';
import type { AstarteInterface } from './models/Interface';
import type { AstarteBlock } from './models/Block';
import type { AstarteTrigger } from './models/Trigger';
import type {
  AstarteBlockDTO,
  AstarteDeviceDTO,
  AstarteInterfaceValues,
  AstartePropertyData,
  AstarteDatastreamIndividualData,
  AstarteDatastreamObjectData,
  AstarteTransientTriggerDTO,
} from './types';
import { AstarteDeviceEvent, decodeEvent } from './types/events';

export type AstarteClientEvent = 'socketError' | 'socketClose';

export interface AstarteInterfaceDescriptor {
  name: string;
  major: number;
  minor: number;
}

type InterfaceOrInterfaceNameParams =
  | { interfaceName: AstarteInterface['name'] }
  | { interface: AstarteInterface };

// Wrap phoenix lib calls in promise for async handling
async function openNewSocketConnection(
  connectionParams: { socketUrl: string; realm: string; token: string },
  onErrorHanlder: () => void,
  onCloseHandler: () => void,
): Promise<Socket> {
  const { socketUrl, realm, token } = connectionParams;

  return new Promise((resolve) => {
    const phoenixSocket = new Socket(socketUrl, {
      params: {
        realm,
        token,
      },
    });
    phoenixSocket.onError(onErrorHanlder);
    phoenixSocket.onClose(onCloseHandler);
    phoenixSocket.onOpen(() => {
      resolve(phoenixSocket);
    });
    phoenixSocket.connect();
  });
}

async function joinChannel(phoenixSocket: Socket, channelString: string): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const channel = phoenixSocket.channel(channelString, {});
    channel
      .join()
      .receive('ok', () => {
        resolve(channel);
      })
      .receive('error', (err: unknown) => {
        reject(err);
      });
  });
}

async function leaveChannel(channel: Channel): Promise<void> {
  return new Promise((resolve, reject) => {
    channel
      .leave()
      .receive('ok', () => {
        resolve();
      })
      .receive('error', (err: unknown) => {
        reject(err);
      });
  });
}

async function registerTrigger(
  channel: Channel,
  triggerPayload: AstarteTransientTriggerDTO,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel
      .push('watch', triggerPayload)
      .receive('ok', () => {
        resolve();
      })
      .receive('error', (err: unknown) => {
        reject(err);
      });
  });
}

function astarteAPIurl(strings: TemplateStringsArray, baseUrl: string, ...keys: string[]) {
  return (params: Record<string, unknown> = {}) => {
    const values = keys.map((key) => params[key]);
    const endpointUrl = _.flatten(_.zip(strings.slice(1), values)).join('');
    return new URL(endpointUrl, baseUrl).toString();
  };
}

interface AstarteClientConfig {
  appEngineApiUrl: string;
  flowApiUrl: string;
  pairingApiUrl: string;
  realm?: string;
  realmManagementApiUrl: string;
  token?: string;
}

class AstarteClient {
  private config: { realm: string };

  private apiConfig: Record<string, (params?: Record<string, unknown>) => string>;

  private joinedChannels: {
    [roomName: string]: Channel;
  };

  private listeners: {
    [eventName: string]: Array<() => void>;
  };

  private phoenixSocket: Socket | null;

  private token: string;

  constructor(config: AstarteClientConfig) {
    this.config = {
      realm: config.realm || '',
    };

    this.token = config.token || '';

    this.phoenixSocket = null;
    this.joinedChannels = {};
    this.listeners = {};

    this.getConfigAuth = this.getConfigAuth.bind(this);
    this.getDeviceRegistrationLimit = this.getDeviceRegistrationLimit.bind(this);
    this.getBlocks = this.getBlocks.bind(this);
    this.getDeviceData = this.getDeviceData.bind(this);
    this.getDevicesStats = this.getDevicesStats.bind(this);
    this.getInterface = this.getInterface.bind(this);
    this.getInterfaceMajors = this.getInterfaceMajors.bind(this);
    this.getInterfaceNames = this.getInterfaceNames.bind(this);
    this.getTriggerNames = this.getTriggerNames.bind(this);
    this.getTrigger = this.getTrigger.bind(this);
    this.getTriggerDeliveryPolicyNames = this.getTriggerDeliveryPolicyNames.bind(this);
    this.deleteTrigger = this.deleteTrigger.bind(this);
    this.getAppengineHealth = this.getAppengineHealth.bind(this);
    this.getRealmManagementHealth = this.getRealmManagementHealth.bind(this);
    this.getPairingHealth = this.getPairingHealth.bind(this);
    this.getFlowHealth = this.getFlowHealth.bind(this);
    this.getPipeline = this.getPipeline.bind(this);
    this.getPipelines = this.getPipelines.bind(this);
    this.getPolicyNames = this.getPolicyNames.bind(this);

    // prettier-ignore
    this.apiConfig = {
      realmManagementHealth: astarteAPIurl`${config.realmManagementApiUrl}health`,
      auth:                  astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/config/auth`,
      deviceRegistrationLimit: astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/config/device_registration_limit`,
      interfaces:            astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/interfaces`,
      interfaceMajors:       astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/interfaces/${'interfaceName'}`,
      interface:             astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/interfaces/${'interfaceName'}/${'interfaceMajor'}`,
      interfaceData: 
astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/interfaces/${'interfaceName'}/${'interfaceMajor'}`,
      trigger:               astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/triggers/${'triggerName'}`,
      triggers:              astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/triggers`,
      policies:              astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/policies`,
      policy:                astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/policies/${'policyName'}`,
      device:                astarteAPIurl`${config.realmManagementApiUrl}v1/${'realm'}/devices/${'deviceId'}`,
      appengineHealth:       astarteAPIurl`${config.appEngineApiUrl}health`,
      devicesStats:          astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/stats/devices`,
      devices:               astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/devices`,
      deviceInfo:            astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/devices/${'deviceId'}`,
      deviceData:            astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/devices/${'deviceId'}/interfaces/${'interfaceName'}${'path'}?since=${'since'}&since_after=${'sinceAfter'}&to=${'to'}&limit=1000`,
      groups:                astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/groups`,
      groupDevices:          astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/groups/${'groupName'}/devices`,
      deviceInGroup:         astarteAPIurl`${config.appEngineApiUrl}v1/${'realm'}/groups/${'groupName'}/devices/${'deviceId'}`,
      phoenixSocket:         astarteAPIurl`${config.appEngineApiUrl}v1/socket`,
      pairingHealth:         astarteAPIurl`${config.pairingApiUrl}health`,
      registerDevice:        astarteAPIurl`${config.pairingApiUrl}v1/${'realm'}/agent/devices`,
      deviceAgent:           astarteAPIurl`${config.pairingApiUrl}v1/${'realm'}/agent/devices/${'deviceId'}`,
      flowHealth:            astarteAPIurl`${config.flowApiUrl}health`,
      flows:                 astarteAPIurl`${config.flowApiUrl}v1/${'realm'}/flows`,
      flowInstance:          astarteAPIurl`${config.flowApiUrl}v1/${'realm'}/flows/${'instanceName'}`,
      pipelines:             astarteAPIurl`${config.flowApiUrl}v1/${'realm'}/pipelines`,
      pipelineSource:        astarteAPIurl`${config.flowApiUrl}v1/${'realm'}/pipelines/${'pipelineId'}`,
      blocks:                astarteAPIurl`${config.flowApiUrl}v1/${'realm'}/blocks`,
      blockSource:           astarteAPIurl`${config.flowApiUrl}v1/${'realm'}/blocks/${'blockId'}`,
    };
  }

  addListener(eventName: AstarteClientEvent, callback: () => void): void {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }

    this.listeners[eventName].push(callback);
  }

  removeListener(eventName: AstarteClientEvent, callback: () => void): void {
    const previousListeners = this.listeners[eventName];
    if (previousListeners) {
      this.listeners[eventName] = previousListeners.filter((listener) => listener !== callback);
    }
  }

  private dispatch(eventName: AstarteClientEvent): void {
    const listeners = this.listeners[eventName];
    if (listeners) {
      listeners.forEach((listener) => listener());
    }
  }

  setCredentials(params: { realm: string; token: string } | null): void {
    this.config.realm = _.get(params, 'realm') || '';
    this.token = _.get(params, 'token') || '';
  }

  async getConfigAuth(): Promise<{ publicKey: string }> {
    const response = await this.$get(this.apiConfig.auth(this.config));
    return { publicKey: response.data.jwt_public_key_pem };
  }

  async updateConfigAuth(params: { publicKey: string }): Promise<void> {
    await this.$put(this.apiConfig.auth(this.config), {
      jwt_public_key_pem: params.publicKey,
    });
  }

  async getDeviceRegistrationLimit(): Promise<number | null> {
    const response = await this.$get(this.apiConfig.deviceRegistrationLimit(this.config));
    return response.data;
  }

  async getPolicyNames(): Promise<string[]> {
    const response = await this.$get(this.apiConfig.policies(this.config));
    return response.data;
  }

  async getInterfaceNames(): Promise<string[]> {
    const response = await this.$get(this.apiConfig.interfaces(this.config));
    return response.data;
  }

  async getInterfaceMajors(interfaceName: string): Promise<number[]> {
    const response = await this.$get(
      this.apiConfig.interfaceMajors({ ...this.config, interfaceName }),
    );
    return response.data;
  }

  async getInterface(params: {
    interfaceName: AstarteInterface['name'];
    interfaceMajor: AstarteInterface['major'];
  }): Promise<AstarteInterface> {
    const { interfaceName, interfaceMajor } = params;
    const response = await this.$get(
      this.apiConfig.interfaceData({
        interfaceName,
        interfaceMajor,
        ...this.config,
      }),
    );
    return fromAstarteInterfaceDTO(response.data);
  }

  async installInterface(iface: AstarteInterface): Promise<void> {
    await this.$post(this.apiConfig.interfaces(this.config), toAstarteInterfaceDTO(iface));
  }

  async updateInterface(iface: AstarteInterface): Promise<void> {
    await this.$put(
      this.apiConfig.interface({
        interfaceName: iface.name,
        interfaceMajor: iface.major,
        ...this.config,
      }),
      toAstarteInterfaceDTO(iface),
    );
  }

  async deleteInterface(
    interfaceName: AstarteInterface['name'],
    interfaceMajor: AstarteInterface['major'],
  ): Promise<void> {
    await this.$delete(this.apiConfig.interface({ ...this.config, interfaceName, interfaceMajor }));
  }

  async getTriggerNames(): Promise<string[]> {
    const response = await this.$get(this.apiConfig.triggers(this.config));
    return response.data;
  }

  async getTrigger(triggerName: string): Promise<AstarteTrigger> {
    const encodedTriggerName = encodeURIComponent(triggerName);
    const response = await this.$get(
      this.apiConfig.trigger({ ...this.config, triggerName: encodedTriggerName }),
    );
    return fromAstarteTriggerDTO(response.data);
  }

  async deleteTrigger(triggerName: string): Promise<void> {
    const encodedTriggerName = encodeURIComponent(triggerName);
    await this.$delete(this.apiConfig.trigger({ ...this.config, triggerName: encodedTriggerName }));
  }

  async installTrigger(trigger: AstarteTrigger): Promise<void> {
    await this.$post(this.apiConfig.triggers(this.config), toAstarteTriggerDTO(trigger));
  }

  async getTriggerDeliveryPolicyNames(): Promise<string[]> {
    const response = await this.$get(this.apiConfig.policies(this.config));
    return response.data;
  }

  async installTriggerDeliveryPolicy(policy: AstarteTriggerDeliveryPolicyDTO): Promise<void> {
    await this.$post(this.apiConfig.policies(this.config), policy);
  }

  async getTriggerDeliveryPolicy(policyName: string): Promise<AstarteTriggerDeliveryPolicyDTO> {
    const response = await this.$get(this.apiConfig.policy({ ...this.config, policyName }));
    return response.data;
  }

  async deleteTriggerDeliveryPolicy(policyName: string): Promise<void> {
    await this.$delete(this.apiConfig.policy({ ...this.config, policyName }));
  }

  async getDevicesStats(): Promise<{ connectedDevices: number; totalDevices: number }> {
    const response = await this.$get(this.apiConfig.devicesStats(this.config));
    return {
      connectedDevices: response.data.connected_devices,
      totalDevices: response.data.total_devices,
    };
  }

  async getDevices(params: {
    details?: boolean;
    from?: string;
    limit?: number;
  }): Promise<{ devices: AstarteDevice[]; nextToken: string | null }> {
    const endpointUri = new URL(this.apiConfig.devices(this.config));
    // eslint-disable-next-line camelcase
    const query: { details?: string; limit?: string; from_token?: string } = {};
    if (params.details) {
      query.details = true.toString();
    }
    if (params.limit) {
      query.limit = params.limit.toString();
    }
    if (params.from) {
      query.from_token = params.from;
    }
    endpointUri.search = new URLSearchParams(query).toString();
    const response = await this.$get(endpointUri.toString());
    const devices = response.data.map((device: AstarteDeviceDTO) => fromAstarteDeviceDTO(device));
    const nextToken = new URLSearchParams(response.links.next).get('from_token');
    return { devices, nextToken };
  }

  async getDeviceInfo(deviceId: AstarteDevice['id']): Promise<AstarteDevice> {
    const response = await this.$get(this.apiConfig.deviceInfo({ deviceId, ...this.config }));
    return fromAstarteDeviceDTO(response.data);
  }

  async insertDeviceAlias(
    deviceId: AstarteDevice['id'],
    aliasKey: string,
    aliasValue: string,
  ): Promise<void> {
    await this.$patch(this.apiConfig.deviceInfo({ deviceId, ...this.config }), {
      aliases: { [aliasKey]: aliasValue },
    });
  }

  async deleteDeviceAlias(deviceId: AstarteDevice['id'], aliasKey: string): Promise<void> {
    await this.$patch(this.apiConfig.deviceInfo({ deviceId, ...this.config }), {
      aliases: { [aliasKey]: null },
    });
  }

  async insertDeviceAttribute(
    deviceId: AstarteDevice['id'],
    attributeKey: string,
    attributeValue: string,
  ): Promise<void> {
    await this.$patch(this.apiConfig.deviceInfo({ deviceId, ...this.config }), {
      attributes: { [attributeKey]: attributeValue },
    });
  }

  async deleteDeviceAttribute(deviceId: AstarteDevice['id'], attributeKey: string): Promise<void> {
    await this.$patch(this.apiConfig.deviceInfo({ deviceId, ...this.config }), {
      attributes: { [attributeKey]: null },
    });
  }

  async inhibitDeviceCredentialsRequests(
    deviceId: AstarteDevice['id'],
    inhibit: boolean,
  ): Promise<void> {
    await this.$patch(this.apiConfig.deviceInfo({ deviceId, ...this.config }), {
      credentials_inhibited: inhibit,
    });
  }

  async getDeviceData(params: {
    deviceId: AstarteDevice['id'];
    interfaceName: AstarteInterface['name'];
    path?: string;
    since?: string;
    sinceAfter?: string;
    to?: string;
    limit?: number;
  }): Promise<AstarteInterfaceValues> {
    const response = await this.$get(
      this.apiConfig.deviceData({
        ...params,
        ...this.config,
      }),
    );
    return response.data;
  }

  async getDeviceDataTree(
    params: {
      deviceId: AstarteDevice['id'];
      path?: string;
      since?: string;
      sinceAfter?: string;
      to?: string;
      limit?: number;
    } & InterfaceOrInterfaceNameParams,
  ): Promise<
    | AstarteDataTreeNode<AstartePropertyData>
    | AstarteDataTreeNode<AstarteDatastreamIndividualData>
    | AstarteDataTreeNode<AstarteDatastreamObjectData>
  > {
    let iface: AstarteInterface;
    if ('interface' in params) {
      iface = params.interface;
    } else {
      const device = await this.getDeviceInfo(params.deviceId);
      const interfaceIntrospection = device.introspection.get(params.interfaceName);
      if (!interfaceIntrospection) {
        throw new Error(`Could not find interface ${params.interfaceName} in device introspection`);
      }
      iface = await this.getInterface({
        interfaceName: params.interfaceName,
        interfaceMajor: interfaceIntrospection.major,
      });
    }
    const interfaceValues = await this.getDeviceData({
      deviceId: params.deviceId,
      interfaceName: iface.name,
      path: params.path,
      since: params.since,
      sinceAfter: params.sinceAfter,
      to: params.to,
      limit: params.limit,
    });
    return toAstarteDataTree({
      interface: iface,
      data: interfaceValues,
      endpoint: params.path,
    });
  }

  async getGroupList(): Promise<string[]> {
    const response = await this.$get(this.apiConfig.groups(this.config));
    return response.data;
  }

  async createGroup(params: {
    groupName: string;
    deviceIds: AstarteDevice['id'][];
  }): Promise<void> {
    const { groupName, deviceIds } = params;
    await this.$post(this.apiConfig.groups(this.config), {
      group_name: groupName,
      devices: deviceIds,
    });
  }

  async getDevicesInGroup(params: {
    groupName: string;
    details?: boolean;
  }): Promise<AstarteDevice[]> {
    const { groupName, details } = params;
    if (!groupName) {
      throw new Error('Invalid group name');
    }
    /* Double encoding to preserve the URL format when groupName contains % and / */
    const encodedGroupName = encodeURIComponent(encodeURIComponent(groupName));
    const endpointUri = new URL(
      this.apiConfig.groupDevices({
        ...this.config,
        groupName: encodedGroupName,
      }),
    );
    if (details) {
      endpointUri.search = new URLSearchParams({ details: 'true' }).toString();
    }
    const response = await this.$get(endpointUri.toString());
    return response.data.map((device: AstarteDeviceDTO) => fromAstarteDeviceDTO(device));
  }

  async addDeviceToGroup(params: { groupName: string; deviceId: string }): Promise<void> {
    const { groupName, deviceId } = params;

    if (!groupName) {
      throw new Error('Invalid group name');
    }

    if (!deviceId) {
      throw new Error('Invalid device ID');
    }

    /* Double encoding to preserve the URL format when groupName contains % and / */
    const encodedGroupName = encodeURIComponent(encodeURIComponent(groupName));

    await this.$post(
      this.apiConfig.groupDevices({
        ...this.config,
        groupName: encodedGroupName,
      }),
      { device_id: deviceId },
    );
  }

  async removeDeviceFromGroup(params: { groupName: string; deviceId: string }): Promise<void> {
    const { groupName, deviceId } = params;

    if (!groupName) {
      throw new Error('Invalid group name');
    }

    if (!deviceId) {
      throw new Error('Invalid device ID');
    }

    /* Double encoding to preserve the URL format when groupName contains % and / */
    const encodedGroupName = encodeURIComponent(encodeURIComponent(groupName));

    await this.$delete(
      this.apiConfig.deviceInGroup({
        ...this.config,
        groupName: encodedGroupName,
        deviceId,
      }),
    );
  }

  async registerDevice(params: {
    deviceId: AstarteDevice['id'];
    introspection?: { [interfaceName: string]: AstarteInterfaceDescriptor };
  }): Promise<{ credentialsSecret: string }> {
    const { deviceId, introspection } = params;
    type RequestBody = {
      // eslint-disable-next-line camelcase
      hw_id: string;
      // eslint-disable-next-line camelcase
      initial_introspection?: Record<string, { major: number; minor: number }>;
    };
    const requestBody: RequestBody = {
      hw_id: deviceId,
    };
    if (introspection) {
      const initialIntrospection = _.mapValues(introspection, (interfaceDescriptor) =>
        _.pick(interfaceDescriptor, ['minor', 'major']),
      );
      requestBody.initial_introspection = initialIntrospection;
    }
    const response = await this.$post(this.apiConfig.registerDevice(this.config), requestBody);
    return { credentialsSecret: response.data.credentials_secret };
  }

  async wipeDeviceCredentials(deviceId: AstarteDevice['id']): Promise<void> {
    await this.$delete(this.apiConfig.deviceAgent({ deviceId, ...this.config }));
  }

  async deleteDevice(deviceId: AstarteDevice['id']): Promise<void> {
    await this.$delete(this.apiConfig.device({ ...this.config, deviceId }));
  }

  async getFlowInstances(): Promise<Array<AstarteFlow['name']>> {
    const response = await this.$get(this.apiConfig.flows(this.config));
    return response.data;
  }

  async getFlowDetails(flowName: AstarteFlow['name']): Promise<AstarteFlow> {
    const response = await this.$get(
      this.apiConfig.flowInstance({ ...this.config, instanceName: flowName }),
    );
    return AstarteFlow.fromObject(response.data);
  }

  async createNewFlowInstance(params: {
    name: AstarteFlow['name'];
    pipeline: string;
    config: { [key: string]: unknown };
  }): Promise<void> {
    await this.$post(this.apiConfig.flows(this.config), params);
  }

  async deleteFlowInstance(flowName: AstarteFlow['name']): Promise<void> {
    await this.$delete(this.apiConfig.flowInstance({ ...this.config, instanceName: flowName }));
  }

  async getPipelineNames(): Promise<Array<AstartePipeline['name']>> {
    const response = await this.$get(this.apiConfig.pipelines(this.config));
    return response.data;
  }

  async getPipelines(): Promise<AstartePipeline[]> {
    const pipelineNames = await this.getPipelineNames();
    const pipelines = await Promise.all(pipelineNames.map(this.getPipeline));
    return pipelines;
  }

  async getPipeline(pipelineId: AstartePipeline['name']): Promise<AstartePipeline> {
    const response = await this.$get(this.apiConfig.pipelineSource({ ...this.config, pipelineId }));
    return new AstartePipeline(fromAstartePipelineDTO(response.data));
  }

  async registerPipeline(pipeline: AstartePipeline): Promise<void> {
    await this.$post(this.apiConfig.pipelines(this.config), toAstartePipelineDTO(pipeline));
  }

  async deletePipeline(pipelineId: string): Promise<void> {
    await this.$delete(this.apiConfig.pipelineSource({ ...this.config, pipelineId }));
  }

  async getBlocks(): Promise<AstarteBlock[]> {
    const staticBlocks = definitions.blocks as AstarteBlockDTO[];
    const response = await this.$get(this.apiConfig.blocks(this.config));
    const fetchedBlocks = response.data as AstarteBlockDTO[];
    const allBlocks = _.uniqBy(fetchedBlocks.concat(staticBlocks), 'name');
    return allBlocks.map((block: AstarteBlockDTO) => toAstarteBlock(block));
  }

  async registerBlock(block: AstarteCustomBlock): Promise<void> {
    const staticBlocksName = definitions.blocks.map((b) => b.name);
    if (staticBlocksName.includes(block.name)) {
      throw new Error("The block's name already exists");
    }
    await this.$post(this.apiConfig.blocks(this.config), block);
  }

  async getBlock(blockId: AstarteBlock['name']): Promise<AstarteBlock> {
    let blockDTO: AstarteBlockDTO;
    const staticBlocksName = definitions.blocks.map((block) => block.name);
    if (staticBlocksName.includes(blockId)) {
      blockDTO = definitions.blocks.find((block) => block.name === blockId) as AstarteBlockDTO;
    } else {
      const response = await this.$get(this.apiConfig.blockSource({ ...this.config, blockId }));
      blockDTO = response.data;
    }
    return toAstarteBlock(blockDTO);
  }

  async deleteBlock(blockId: AstarteBlock['name']): Promise<void> {
    const staticBlocksName = definitions.blocks.map((b) => b.name);
    if (staticBlocksName.includes(blockId)) {
      throw new Error('Cannot delete a native block');
    }
    await this.$delete(this.apiConfig.blockSource({ ...this.config, blockId }));
  }

  async getRealmManagementHealth(): Promise<void> {
    await this.$get(this.apiConfig.realmManagementHealth(this.config));
  }

  async getAppengineHealth(): Promise<void> {
    await this.$get(this.apiConfig.appengineHealth(this.config));
  }

  async getPairingHealth(): Promise<void> {
    await this.$get(this.apiConfig.pairingHealth(this.config));
  }

  async getFlowHealth(): Promise<void> {
    await this.$get(this.apiConfig.flowHealth(this.config));
  }

  private async $get(url: string) {
    return axios({
      method: 'get',
      url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
    }).then((response) => response.data);
  }

  private async $post(url: string, data: unknown) {
    return axios({
      method: 'post',
      url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      data: {
        data,
      },
    }).then((response) => response.data);
  }

  private async $put(url: string, data: unknown) {
    return axios({
      method: 'put',
      url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      data: {
        data,
      },
    }).then((response) => response.data);
  }

  private async $patch(url: string, data: unknown) {
    return axios({
      method: 'patch',
      url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/merge-patch+json',
      },
      data: {
        data,
      },
    }).then((response) => response.data);
  }

  private async $delete(url: string) {
    return axios({
      method: 'delete',
      url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
    }).then((response) => response.data);
  }

  private async openSocketConnection(): Promise<Socket> {
    if (this.phoenixSocket) {
      return Promise.resolve(this.phoenixSocket);
    }

    const socketUrl = new URL(this.apiConfig.phoenixSocket(this.config));
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    return new Promise((resolve) => {
      openNewSocketConnection(
        {
          socketUrl: socketUrl.toString(),
          realm: this.config.realm,
          token: this.token,
        },
        () => {
          this.dispatch('socketError');
        },
        () => {
          this.dispatch('socketClose');
        },
      ).then((socket) => {
        this.phoenixSocket = socket;
        resolve(socket);
      });
    });
  }

  async joinRoom(roomName: string): Promise<Channel> {
    const { phoenixSocket } = this;
    if (!phoenixSocket) {
      return new Promise((resolve) => {
        this.openSocketConnection().then(() => {
          resolve(this.joinRoom(roomName));
        });
      });
    }

    const channel = this.joinedChannels[roomName];
    if (channel) {
      return Promise.resolve(channel);
    }

    return new Promise((resolve) => {
      joinChannel(phoenixSocket, `rooms:${this.config.realm}:${roomName}`).then((joinedChannel) => {
        this.joinedChannels[roomName] = joinedChannel;
        resolve(joinedChannel);
      });
    });
  }

  async listenForEvents(
    roomName: string,
    eventHandler: (event: AstarteDeviceEvent) => void,
  ): Promise<void> {
    const channel = this.joinedChannels[roomName];
    if (!channel) {
      return Promise.reject(new Error("Can't listen for room events before joining it first"));
    }

    channel.on('new_event', (jsonEvent: unknown) => {
      const decodedEvent = decodeEvent(jsonEvent);

      if (decodedEvent) {
        eventHandler(decodedEvent);
      } else {
        throw new Error('Unrecognised event received');
      }
    });
    return Promise.resolve();
  }

  async registerVolatileTrigger(
    roomName: string,
    triggerPayload: AstarteTransientTriggerDTO,
  ): Promise<void> {
    const channel = this.joinedChannels[roomName];
    if (!channel) {
      return Promise.reject(new Error("Room not joined, couldn't register trigger"));
    }

    return registerTrigger(channel, triggerPayload);
  }

  async leaveRoom(roomName: string): Promise<void> {
    const channel = this.joinedChannels[roomName];
    if (!channel) {
      return Promise.reject(new Error("Can't leave a room without joining it first"));
    }

    return leaveChannel(channel).then(() => {
      delete this.joinedChannels[roomName];
    });
  }

  get joinedRooms(): string[] {
    const rooms: string[] = [];
    Object.keys(this.joinedChannels).forEach((roomName) => {
      rooms.push(roomName);
    });
    return rooms;
  }

  get realm(): string | null {
    return this.config.realm || null;
  }
}

export default AstarteClient;
