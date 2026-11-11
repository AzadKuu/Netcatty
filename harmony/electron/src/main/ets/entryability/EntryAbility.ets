// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import abilityAccessCtrl, { Permissions, PermissionRequestResult } from '@ohos.abilityAccessCtrl';
import { BusinessError } from '@ohos.base';
import hilog from '@ohos.hilog';

import { WebAbility } from 'web_engine';

const PERMISSION_DOMAIN: number = 0x0000;
const PERMISSION_TAG: string = 'NetcattyPermissions';

// HarmonyOS keeps the user's home directory out of reach for ordinary apps
// (scandir returns EPERM, spawn returns EACCES). These two grants are the only
// directory level permissions a normal certificate can obtain, and they are what
// makes ~/Download and ~/Documents readable, so downloads can land where users
// expect them and tools installed there stay reachable.
const STORAGE_PERMISSIONS: Permissions[] = [
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
];

export default class EntryAbility extends WebAbility {
  private storagePermissionAttempts: number = 0;

  onConfigurationUpdate(config: Configuration) {
    super.onConfigurationUpdate(config);
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onCreate(want, launchParam);
  }

  async onPrepareToTerminateAsync(): Promise<boolean> {
    return await super.onPrepareToTerminateAsync();
  }

  async onDestroy(): Promise<void> {
    await super.onDestroy();
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    super.onWindowStageCreate(windowStage);
  }

  private requestStoragePermissions(): void {
    const atManager = abilityAccessCtrl.createAtManager();
    atManager.requestPermissionsFromUser(this.context, STORAGE_PERMISSIONS)
      .then((result: PermissionRequestResult) => {
        hilog.info(PERMISSION_DOMAIN, PERMISSION_TAG, 'storage permission results: %{public}s',
          JSON.stringify(result.authResults));
        return;
      })
      .catch((err: BusinessError) => {
        hilog.error(PERMISSION_DOMAIN, PERMISSION_TAG, 'storage permission request failed: %{public}s',
          JSON.stringify(err));
        return;
      });
  }

  onWindowStageDestroy() {
    super.onWindowStageDestroy();
  }

  onForeground() {
    super.onForeground();
    // Asking while the window stage is still being created returns a silent
    // "denied" without showing any dialog, so the request waits until the
    // ability is actually in the foreground. Two attempts cover the case where
    // the user dismisses the sheet the first time.
    if (this.storagePermissionAttempts < 2) {
      this.storagePermissionAttempts += 1;
      this.requestStoragePermissions();
    }
  }

  onBackground() {
    super.onBackground();
  }
};
