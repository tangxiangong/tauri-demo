import mapboxgl from 'mapbox-gl';
import {
  checkPermissions,
  requestPermissions,
  getCurrentPosition,
  watchPosition
} from '@tauri-apps/plugin-geolocation';
import { Store } from '@tauri-apps/plugin-store';
import { exit } from '@tauri-apps/plugin-process';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

// 配置管理类
class ConfigManager {
  private store: Store | null = null;
  private static STORE_FILENAME = 'config.json';
  private static TOKEN_KEY = 'mapbox_token';

  constructor() {
    this.initStore();
  }

  // 初始化 store
  private async initStore() {
    try {
      this.store = await Store.load(ConfigManager.STORE_FILENAME);
      console.log('Store 初始化成功');
    } catch (error) {
      console.log('Store 不存在，将创建新的 store:', error);
      this.store = await Store.load(ConfigManager.STORE_FILENAME);
    }
  }

  // 确保 store 已初始化
  private async ensureStore(): Promise<Store> {
    if (!this.store) {
      this.store = await Store.load(ConfigManager.STORE_FILENAME);
    }
    return this.store;
  }

  // 获取存储的 token
  async getStoredToken(): Promise<string | null> {
    try {
      console.log('开始获取存储的 token...');
      const store = await this.ensureStore();
      const token = await store.get<string>(ConfigManager.TOKEN_KEY);
      console.log('获取 token 结果:', token ? '已找到 token' : '未找到 token');
      return token || null;
    } catch (error) {
      console.error('获取存储的 token 失败:', error);
      return null;
    }
  }

  // 保存 token
  async saveToken(token: string): Promise<boolean> {
    try {
      console.log('开始保存 token...');
      const store = await this.ensureStore();
      await store.set(ConfigManager.TOKEN_KEY, token);
      console.log('Token 已设置到 store');
      await store.save();
      console.log('Store 已保存到文件');

      // 验证保存是否成功
      const savedToken = await store.get<string>(ConfigManager.TOKEN_KEY);
      if (savedToken === token) {
        console.log('Token 保存验证成功');
        return true;
      } else {
        console.error('Token 保存验证失败');
        return false;
      }
    } catch (error) {
      console.error('保存 token 失败:', error);
      return false;
    }
  }

  // 删除 token
  async removeToken(): Promise<boolean> {
    try {
      console.log('开始删除 token...');
      const store = await this.ensureStore();
      await store.delete(ConfigManager.TOKEN_KEY);
      console.log('Token 已从 store 中删除');
      await store.save();
      console.log('Store 已保存，删除操作完成');

      // 验证删除是否成功
      const remainingToken = await store.get<string>(ConfigManager.TOKEN_KEY);
      if (remainingToken) {
        console.error('删除验证失败，token 仍然存在:', remainingToken);
        return false;
      } else {
        console.log('删除验证成功，token 已完全移除');
        return true;
      }
    } catch (error) {
      console.error('删除 token 失败:', error);
      return false;
    }
  }

  // 验证 token 格式
  validateToken(token: string): boolean {
    // Mapbox token 通常以 pk. 开头，长度较长
    return token.startsWith('pk.') && token.length > 50;
  }
}

// 初始化 token
async function initializeMapboxToken(configManager: ConfigManager): Promise<string | null> {
  // 直接从存储获取 token，不再使用环境变量
  const storedToken = await configManager.getStoredToken();
  return storedToken;
}

// 地理位置相关功能
class LocationService {
  private map: mapboxgl.Map;
  private geolocateControl: mapboxgl.GeolocateControl;
  private watchId: number | null = null;

  constructor(map: mapboxgl.Map) {
    this.map = map;
    this.geolocateControl = new mapboxgl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 600000 // 10分钟缓存
      },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: false
    });

    this.setupLocationControl();
  }

  private setupLocationControl() {
    // 添加定位控件到地图
    this.map.addControl(this.geolocateControl, 'top-right');

    // 监听定位成功事件
    this.geolocateControl.on('geolocate', (e) => {
      console.log('Mapbox定位成功:', e.coords);
      this.showLocationSuccess(e.coords);
    });

    // 监听定位错误事件
    this.geolocateControl.on('error', (e) => {
      console.error('Mapbox定位失败:', e);
      // 如果Mapbox定位失败，尝试使用Tauri API
      this.tryTauriGeolocation();
    });

    // 监听追踪模式变化
    this.geolocateControl.on('trackuserlocationstart', () => {
      console.log('开始追踪用户位置');
    });

    this.geolocateControl.on('trackuserlocationend', () => {
      console.log('停止追踪用户位置');
      if (this.watchId !== null) {
        // 停止Tauri位置监听
        this.stopWatching();
      }
    });
  }

  // 使用Tauri地理位置API
  private async tryTauriGeolocation() {
    try {
      console.log('尝试使用Tauri地理位置API...');

      // 检查权限
      let permissions = await checkPermissions();
      console.log('当前权限状态:', permissions);

      // 权限处理
      if (permissions.location !== 'granted') {
        console.log('位置权限未授予，尝试请求权限...');

        // 多次尝试请求权限
        for (let i = 0; i < 3; i++) {
          console.log(`第 ${i + 1} 次请求位置权限...`);
          try {
            permissions = await requestPermissions(['location']);
            console.log('权限请求结果:', permissions);

            if (permissions.location === 'granted') {
              console.log('权限请求成功！');
              break;
            } else {
              console.log(`权限请求未成功，状态: ${permissions.location}`);
            }
          } catch (error) {
            console.error(`第 ${i + 1} 次权限请求失败:`, error);
          }

          // 短暂等待后再次尝试
          if (i < 2) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        // 如果权限仍未授予
        if (permissions.location !== 'granted') {
          // 根据平台提供不同的指导
          let errorMessage = '位置权限被拒绝';

          if (navigator.platform.includes('Mac')) {
            errorMessage = '请在 系统设置 > 隐私与安全性 > 位置服务 中允许此应用访问位置信息，然后重启应用。';
          } else if (navigator.platform.includes('Win')) {
            errorMessage = '请在 Windows 设置 > 隐私 > 位置 中允许此应用访问位置信息，然后重启应用。';
          } else {
            errorMessage = '请在系统设置中允许此应用访问位置信息，然后重启应用。';
          }

          this.showLocationError({
            code: 1,
            message: errorMessage
          });
          return;
        }
      }

      if (permissions.location === 'granted') {
        console.log('权限已授予，获取当前位置...');
        const position = await getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        });

        console.log('Tauri定位成功:', position);

        // 将位置显示在地图上
        this.map.flyTo({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: 15
        });

        // 添加标记
        new mapboxgl.Marker()
          .setLngLat([position.coords.longitude, position.coords.latitude])
          .addTo(this.map);

        // 转换为GeolocationCoordinates格式
        const coords: GeolocationCoordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          altitude: position.coords.altitude,
          accuracy: position.coords.accuracy,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          heading: position.coords.heading,
          speed: position.coords.speed,
          toJSON: function () { return this; }
        };
        this.showLocationSuccess(coords);

        // 开始监听位置变化
        this.startWatching();
      } else {
        throw new Error(`位置权限被拒绝: ${permissions.location}`);
      }
    } catch (error) {
      console.error('Tauri地理位置获取失败:', error);
      this.showLocationError(error);
    }
  }

  // 开始监听位置变化
  private async startWatching() {
    try {
      this.watchId = await watchPosition(
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        },
        (position) => {
          if (position && position.coords) {
            console.log('位置更新:', position);
            // 更新地图中心
            this.map.easeTo({
              center: [position.coords.longitude, position.coords.latitude]
            });
          }
        }
      );
      console.log('开始监听位置变化, watchId:', this.watchId);
    } catch (error) {
      console.error('开始监听位置失败:', error);
    }
  }

  // 停止监听位置变化
  private stopWatching() {
    if (this.watchId !== null) {
      // 注意：当前版本的API可能没有clearWatch函数
      // 这里我们只是重置watchId
      console.log('停止监听位置变化');
      this.watchId = null;
    }
  }

  private showLocationSuccess(coords: GeolocationCoordinates) {
    // 创建成功提示
    this.createNotification('定位成功', `
      <div class="notification-content">
        <div class="notification-icon">📍</div>
        <div class="notification-text">
          <div class="notification-title">定位成功</div>
          <div class="notification-subtitle">精度: ${coords.accuracy.toFixed(0)}米</div>
        </div>
      </div>
    `, 'success');
  }

  private async showLocationError(error: GeolocationPositionError | any) {
    let errorMessage = '定位失败';
    let errorDetail = '';

    if (error.code) {
      switch (error.code) {
        case 1:
          errorMessage = '权限被拒绝';
          errorDetail = '请在系统设置中允许位置访问权限';
          break;
        case 2:
          errorMessage = '位置不可用';
          errorDetail = '无法获取您的位置信息';
          break;
        case 3:
          errorMessage = '请求超时';
          errorDetail = '定位请求超时，请重试';
          break;
        default:
          errorMessage = '未知错误';
          errorDetail = error.message || '请检查网络连接或重试';
      }
    } else {
      errorDetail = error.message || '请检查网络连接或重试';
    }

    // 创建界面通知
    this.createNotification(errorMessage, `
      <div class="notification-content">
        <div class="notification-icon">❌</div>
        <div class="notification-text">
          <div class="notification-title">${errorMessage}</div>
          <div class="notification-subtitle">${errorDetail}</div>
        </div>
      </div>
    `, 'error');

    // 尝试发送系统通知
    try {
      // 检查通知权限
      let permissionGranted = await isPermissionGranted();

      if (!permissionGranted) {
        // 请求通知权限
        const result = await requestPermission();
        permissionGranted = result === 'granted';
      }

      if (permissionGranted) {
        // 发送系统通知
        await sendNotification({
          title: errorMessage,
          body: errorDetail,
          icon: './src-tauri/icons/icon.png'
        });
      }
    } catch (notificationError) {
      console.error('发送系统通知失败:', notificationError);
      // 系统通知失败不影响应用流程
    }
  }

  private createNotification(_title: string, content: string, type: 'success' | 'error') {
    // 移除现有通知
    const existingNotifications = document.querySelectorAll('.location-notification');
    existingNotifications.forEach(notification => notification.remove());

    // 创建新通知
    const notification = document.createElement('div');
    notification.className = `location-notification location-notification-${type}`;
    notification.innerHTML = content;

    // 添加到页面
    document.body.appendChild(notification);

    // 3秒后自动移除
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 3000);
  }

  // 检查地理位置权限 (浏览器API)
  async checkLocationPermission(): Promise<PermissionState | null> {
    if (!navigator.permissions) {
      return null;
    }

    try {
      const result = await navigator.permissions.query({ name: 'geolocation' });
      return result.state;
    } catch (error) {
      console.log('无法检查地理位置权限:', error);
      return null;
    }
  }

  // 检查Tauri地理位置权限
  async checkTauriLocationPermission() {
    try {
      const permissions = await checkPermissions();
      console.log('Tauri位置权限状态:', permissions);
      return permissions;
    } catch (error) {
      console.error('检查Tauri位置权限失败:', error);
      return null;
    }
  }

  // 手动触发定位
  async triggerLocation() {
    try {
      console.log('手动触发定位...');

      // 首先尝试检查Tauri权限
      const tauriPermission = await this.checkTauriLocationPermission();
      console.log('Tauri位置权限状态:', tauriPermission);

      // 如果权限被明确拒绝
      if (tauriPermission && tauriPermission.location === 'denied') {
        this.showLocationError({
          code: 1,
          message: '地理位置权限被拒绝，请在系统设置中允许位置访问后重启应用'
        });
        return;
      }

      // 如果权限未授予，尝试请求权限
      if (tauriPermission && tauriPermission.location !== 'granted') {
        console.log('尝试请求Tauri位置权限...');
        try {
          const newPermissions = await requestPermissions(['location']);
          console.log('权限请求结果:', newPermissions);

          // 如果请求后权限仍未授予
          if (newPermissions.location !== 'granted') {
            // 根据平台提供不同的指导
            let errorMessage = '位置权限被拒绝';

            if (navigator.platform.includes('Mac')) {
              errorMessage = '请在 系统设置 > 隐私与安全性 > 位置服务 中允许此应用访问位置信息，然后重启应用。';
            } else if (navigator.platform.includes('Win')) {
              errorMessage = '请在 Windows 设置 > 隐私 > 位置 中允许此应用访问位置信息，然后重启应用。';
            } else {
              errorMessage = '请在系统设置中允许此应用访问位置信息，然后重启应用。';
            }

            this.showLocationError({
              code: 1,
              message: errorMessage
            });
            return;
          }
        } catch (error) {
          console.error('权限请求失败:', error);
          this.showLocationError({
            code: 1,
            message: '权限请求失败，请在系统设置中手动允许位置访问'
          });
          return;
        }
      }

      // 如果权限OK，先尝试使用Tauri API
      console.log('尝试使用Tauri API获取位置...');
      try {
        await this.tryTauriGeolocation();
      } catch (error) {
        console.error('Tauri定位失败，尝试使用Mapbox定位:', error);
        // 回退到Mapbox定位
        this.geolocateControl.trigger();
      }
    } catch (error) {
      console.error('触发定位失败:', error);
      // 最后尝试使用Mapbox定位
      this.geolocateControl.trigger();
    }
  }
}

// 配置界面管理
class ConfigUI {
  private configManager: ConfigManager;
  private onTokenChange: (token: string) => void;

  constructor(configManager: ConfigManager, onTokenChange: (token: string) => void) {
    this.configManager = configManager;
    this.onTokenChange = onTokenChange;
    this.setupEventListeners();
  }

  private setupEventListeners() {
    const configBtn = document.getElementById('config-btn');
    const configModal = document.getElementById('config-modal');
    const configClose = document.getElementById('config-close');
    const tokenSave = document.getElementById('token-save');
    const tokenCancel = document.getElementById('token-cancel');
    const tokenDelete = document.getElementById('token-delete');
    const tokenInput = document.getElementById('token-input') as HTMLInputElement;

    // 打开配置弹窗
    configBtn?.addEventListener('click', async () => {
      // 检查是否已有token
      const existingToken = await this.configManager.getStoredToken();

      // 更新弹窗标题和描述
      const modalHeader = document.querySelector('.config-modal-header h3');
      const modalDescription = document.querySelector('.config-description');

      const deleteBtn = document.getElementById('token-delete') as HTMLButtonElement;

      if (existingToken) {
        console.log('检测到已有token，显示删除按钮');
        if (modalHeader) modalHeader.textContent = '更换 Mapbox Token';
        if (modalDescription) {
          modalDescription.innerHTML = `
            当前已配置 Token，您可以<strong>替换</strong>为新的 Token。<br/>
            您可以在 <a href="https://account.mapbox.com/" target="_blank">Mapbox 官网</a> 免费获取。
          `;
        }
        if (deleteBtn) {
          deleteBtn.style.display = 'block';
          console.log('删除按钮已显示');
        } else {
          console.log('未找到删除按钮元素');
        }
      } else {
        console.log('未检测到token，隐藏删除按钮');
        if (modalHeader) modalHeader.textContent = '配置 Mapbox Token';
        if (modalDescription) {
          modalDescription.innerHTML = `
            您可以在 <a href="https://account.mapbox.com/" target="_blank">Mapbox 官网</a> 免费获取。
          `;
        }
        if (deleteBtn) deleteBtn.style.display = 'none';
      }

      // 如果有已存储的token，在输入框中显示
      if (existingToken) {
        tokenInput.value = existingToken;
      } else {
        tokenInput.value = '';
      }

      // 确保输入框是密码模式
      tokenInput.type = 'password';

      configModal?.classList.add('show');
      tokenInput.focus();
    });

    // 关闭配置弹窗
    const closeModal = () => {
      configModal?.classList.remove('show');
      tokenInput.value = '';
      this.clearStatus();
    };

    configClose?.addEventListener('click', closeModal);
    tokenCancel?.addEventListener('click', closeModal);

    // 删除按钮单独绑定事件
    tokenDelete?.addEventListener('click', async (e) => {
      console.log('删除按钮被点击');
      e.stopPropagation(); // 阻止事件冒泡

      console.log('用户确认删除');

      // 显示删除中状态
      this.showStatus('正在删除配置...', 'success');

      try {
        const success = await this.configManager.removeToken();
        console.log('删除操作结果:', success);

        if (success) {
          this.showStatus('配置已删除，即将返回欢迎界面...', 'success');

          // 延迟后通过回调通知删除成功，返回欢迎界面
          setTimeout(() => {
            console.log('删除成功，准备返回欢迎界面');
            console.log('回调函数存在:', typeof this.onTokenChange);

            // 先关闭配置弹窗
            closeModal();

            // 通过回调函数通知删除，传入空字符串表示删除
            console.log('调用回调函数，传入空字符串');
            this.onTokenChange('');
            console.log('回调函数调用完成');
          }, 1000);
        } else {
          console.error('删除失败');
          this.showStatus('删除失败，请重试', 'error');
        }
      } catch (error) {
        console.error('删除操作发生错误:', error);
        this.showStatus('删除失败，发生错误', 'error');
      }
    });

    // 模态框点击背景关闭
    configModal?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target === configModal) {
        // 点击背景关闭
        closeModal();
      }
    });

    // ESC 键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && configModal?.classList.contains('show')) {
        closeModal();
      }
    });

    // 保存 token
    tokenSave?.addEventListener('click', async () => {
      const token = tokenInput.value.trim();
      await this.saveToken(token);
    });

    // 回车保存
    tokenInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const token = tokenInput.value.trim();
        await this.saveToken(token);
      }
    });

    // 实时验证输入
    tokenInput?.addEventListener('input', () => {
      const token = tokenInput.value.trim();
      if (token) {
        if (this.configManager.validateToken(token)) {
          this.showStatus('Token 格式正确', 'success');
        } else {
          this.showStatus('Token 格式不正确，应以 pk. 开头', 'error');
        }
      } else {
        this.clearStatus();
      }
    });

    // 显示/隐藏 Token 按钮
    const toggleVisibilityBtn = document.getElementById('toggle-token-visibility');
    toggleVisibilityBtn?.addEventListener('click', () => {
      const input = document.getElementById('token-input') as HTMLInputElement;
      const button = toggleVisibilityBtn;

      if (input.type === 'password') {
        input.type = 'text';
        button.textContent = '🙈'; // 隐藏图标
        button.title = '隐藏 Token';
      } else {
        input.type = 'password';
        button.textContent = '👁️'; // 显示图标
        button.title = '显示 Token';
      }
    });
  }

  private async saveToken(token: string) {
    const saveBtn = document.getElementById('token-save') as HTMLButtonElement;
    const modal = document.getElementById('config-modal');

    if (!token) {
      this.showStatus('请输入 Token', 'error');
      return;
    }

    if (!this.configManager.validateToken(token)) {
      this.showStatus('Token 格式不正确，应以 pk. 开头', 'error');
      return;
    }

    // 显示保存中状态
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    this.showStatus('正在保存...', 'success');

    try {
      const success = await this.configManager.saveToken(token);
      if (success) {
        this.showStatus('保存成功！', 'success');
        this.onTokenChange(token);

        // 延迟关闭弹窗
        setTimeout(() => {
          modal?.classList.remove('show');
          this.clearStatus();
          (document.getElementById('token-input') as HTMLInputElement).value = '';
        }, 1000);
      } else {
        this.showStatus('存储失败，请检查应用权限', 'error');
      }
    } catch (error) {
      console.error('保存 token 失败:', error);
      if (error instanceof Error) {
        this.showStatus(`保存失败: ${error.message}`, 'error');
      } else {
        this.showStatus('保存失败，请检查存储权限', 'error');
      }
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  }

  private showStatus(message: string, type: 'success' | 'error') {
    const statusEl = document.getElementById('config-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `config-status ${type}`;
    }
  }

  private clearStatus() {
    const statusEl = document.getElementById('config-status');
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'config-status';
    }
  }
}

// 主应用类
class App {
  private configManager: ConfigManager;
  private configUI: ConfigUI | null = null;
  private map: mapboxgl.Map | null = null;
  private locationService: LocationService | null = null;

  constructor() {
    this.configManager = new ConfigManager();
  }

  async initialize() {
    try {
      console.log('初始化应用...');
      this.showLoadingScreen();

      // 初始化配置管理器
      this.configManager = new ConfigManager();

      // 主动请求位置权限
      try {
        console.log('主动请求位置权限...');
        const permissions = await checkPermissions();
        console.log('当前位置权限状态:', permissions);

        if (permissions.location !== 'granted') {
          console.log('位置权限未授予，尝试请求...');
          const result = await requestPermissions(['location']);
          console.log('位置权限请求结果:', result);
        }
      } catch (error) {
        console.error('请求位置权限失败:', error);
        // 继续初始化流程，不阻塞
      }

      // 获取 token
      const token = await initializeMapboxToken(this.configManager);

      // 如果没有 token，显示配置界面
      if (!token) {
        console.log('未找到 token，显示配置界面');
        this.showConfigScreen();
        return;
      }

      // 如果有 token，初始化地图
      console.log('找到 token，初始化地图');
      await this.initializeMap(token);
    } catch (error) {
      console.error('应用初始化失败:', error);
      this.showMapError();
    }
  }

  private showLoadingScreen() {
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
      mapContainer.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f8fafc; color: #64748b;">
          <div style="text-align: center;">
            <div style="margin-bottom: 20px;">
              <div style="width: 40px; height: 40px; margin: 0 auto; border: 4px solid #e2e8f0; border-top: 4px solid #667eea; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            </div>
            <h3 style="margin: 0 0 8px 0; color: #334155;">正在启动应用</h3>
            <p style="margin: 0; color: #64748b;">请稍候...</p>
          </div>
        </div>
      `;
    }
  }

  private showConfigScreen() {
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
      mapContainer.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f8fafc; color: #64748b;">
          <div style="text-align: center; max-width: 400px; padding: 40px;">
            <div style="margin-bottom: 30px;">
              <div style="font-size: 48px; margin-bottom: 16px;">🗺️</div>
              <h2 style="margin: 0 0 12px 0; color: #1e293b; font-size: 24px;">欢迎使用 Mapbox Demo</h2>
              <p style="margin: 0; color: #64748b; line-height: 1.5;">
                首次使用需要配置 Mapbox API Token<br/>
                您可以选择添加配置或退出程序
              </p>
            </div>
            <div style="display: flex; gap: 16px; justify-content: center;">
              <button id="start-config-btn" style="
                background: #667eea;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
              ">
                添加配置
              </button>
              <button id="exit-app-btn" style="
                background: #6b7280;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 4px 12px rgba(107, 114, 128, 0.2);
              ">
                退出程序
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // 初始化配置界面但不显示
    this.configUI = new ConfigUI(this.configManager, async (newToken: string) => {
      console.log('配置UI回调被调用，newToken:', newToken === '' ? '空字符串(删除)' : '有值(保存)');
      if (newToken === '') {
        // 删除配置后，重新初始化应用
        console.log('收到删除通知，重新初始化应用');
        await this.initialize();
        console.log('重新初始化完成');
      } else {
        // 配置完成后初始化地图
        console.log('配置完成，初始化地图');
        await this.initializeMap(newToken);
      }
    });

    // 添加配置按钮事件
    const startConfigBtn = document.getElementById('start-config-btn');
    startConfigBtn?.addEventListener('click', () => {
      // 手动触发配置弹窗前先更新UI状态
      const modalHeader = document.querySelector('.config-modal-header h3');
      const modalDescription = document.querySelector('.config-description');
      const deleteBtn = document.getElementById('token-delete') as HTMLButtonElement;

      // 欢迎界面中，肯定是没有配置的状态
      if (modalHeader) modalHeader.textContent = '配置 Mapbox Token';
      if (modalDescription) {
        modalDescription.innerHTML = `
          您可以在 <a href="https://account.mapbox.com/" target="_blank">Mapbox 官网</a> 免费获取。
        `;
      }
      if (deleteBtn) deleteBtn.style.display = 'none';

      // 手动触发配置弹窗
      const configModal = document.getElementById('config-modal');
      configModal?.classList.add('show');
      const tokenInput = document.getElementById('token-input') as HTMLInputElement;
      tokenInput.value = '';
      tokenInput?.focus();
    });

    // 添加退出按钮事件
    const exitAppBtn = document.getElementById('exit-app-btn');
    exitAppBtn?.addEventListener('click', async () => {
      console.log('退出按钮被点击');
      try {
        // 使用 Tauri process 插件退出应用
        await exit(0);
      } catch (error) {
        console.error('退出应用失败:', error);
        // 如果 Tauri 退出失败，尝试使用 window.close 作为备选
        window.close();
      }
    });

    // 自动弹出配置窗口
    setTimeout(() => {
      // 先更新UI状态
      const modalHeader = document.querySelector('.config-modal-header h3');
      const modalDescription = document.querySelector('.config-description');
      const deleteBtn = document.getElementById('token-delete') as HTMLButtonElement;

      // 欢迎界面中，肯定是没有配置的状态
      if (modalHeader) modalHeader.textContent = '配置 Mapbox Token';
      if (modalDescription) {
        modalDescription.innerHTML = `
          您可以在 <a href="https://account.mapbox.com/" target="_blank">Mapbox 官网</a> 免费获取。
        `;
      }
      if (deleteBtn) deleteBtn.style.display = 'none';

      // 显示配置弹窗
      const configModal = document.getElementById('config-modal');
      configModal?.classList.add('show');
      const tokenInput = document.getElementById('token-input') as HTMLInputElement;
      tokenInput.value = '';
      tokenInput?.focus();
    }, 500);
  }

  private async initializeMap(token: string) {
    mapboxgl.accessToken = token;

    // 显示地图加载状态
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
      mapContainer.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f8fafc; color: #64748b;">
          <div style="text-align: center;">
            <div style="margin-bottom: 20px;">
              <div style="width: 40px; height: 40px; margin: 0 auto; border: 4px solid #e2e8f0; border-top: 4px solid #667eea; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            </div>
            <h3 style="margin: 0 0 8px 0; color: #334155;">正在加载地图</h3>
            <p style="margin: 0; color: #64748b;">请稍候...</p>
          </div>
        </div>
      `;
    }

    try {
      // 重新创建地图容器div
      if (mapContainer) {
        mapContainer.innerHTML = '';
        mapContainer.className = 'map-container';
      }

      this.map = new mapboxgl.Map({
        container: 'map', // 地图容器 ID
        style: 'mapbox://styles/mapbox/streets-v12', // 地图样式
        center: [116.3974, 39.9093], // 初始中心点 [经度, 纬度] - 北京
        zoom: 10, // 初始缩放级别
        pitch: 0, // 地图倾斜角度
        bearing: 0 // 地图旋转角度
      });

      // 初始化配置界面（如果还没有）
      if (!this.configUI) {
        this.configUI = new ConfigUI(this.configManager, async (newToken: string) => {
          if (newToken === '') {
            // 删除配置后，重新初始化应用
            console.log('地图页面收到删除通知，重新初始化应用');
            await this.initialize();
          } else {
            // 更新token后重新加载
            mapboxgl.accessToken = newToken;
            window.location.reload();
          }
        });
      }

      this.setupMapControls();
      this.setupMapEvents();

    } catch (error) {
      console.error('地图初始化失败:', error);
      this.showMapError();
    }
  }

  private setupMapControls() {
    if (!this.map) return;

    // 添加导航控件（缩放按钮）
    this.map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    // 添加全屏控件
    this.map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    // 初始化位置服务
    if (this.map) {
      this.locationService = new LocationService(this.map);
    }

    // 添加比例尺控件
    this.map.addControl(new mapboxgl.ScaleControl({
      maxWidth: 100,
      unit: 'metric'
    }), 'bottom-left');
  }

  private setupMapEvents() {
    if (!this.map) return;

    // 地图加载完成后的回调
    this.map.on('load', async () => {
      console.log('地图加载完成');

      // 检查地理位置权限状态
      this.locationService?.checkLocationPermission().then(permission => {
        if (permission) {
          console.log('地理位置权限状态:', permission);
        }
      });
    });

    // 存储当前的弹出窗口
    let currentPopup: mapboxgl.Popup | null = null;

    // 地图点击事件
    this.map.on('click', async (e) => {
      console.log(`经度 ${e.lngLat.lng}, 纬度 ${e.lngLat.lat}`);

      if (currentPopup) {
        currentPopup.remove();
      }

      // 先显示加载状态
      currentPopup = new mapboxgl.Popup({ closeButton: true, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(`
        <div class="location-popup">
          <div class="location-popup-header">
            <div class="location-popup-title">
              <span class="location-popup-title-icon">📍</span>
              <h3 class="location-popup-title-text">位置信息</h3>
            </div>
          </div>
          
          <div class="location-popup-content">
            <div class="location-section">
              <div class="location-section-header">
                <div class="location-icon location-icon-coordinate">🌍</div>
                <strong class="location-section-title">坐标</strong>
              </div>
              <div class="location-data-box location-coordinate-box">
                <div class="location-coordinate-text">
                  <div class="location-coordinate-row">
                    <span class="location-coordinate-label">经度:</span>
                    <span class="location-coordinate-value">${e.lngLat.lng.toFixed(6)}</span>
                  </div>
                  <div class="location-coordinate-row">
                    <span class="location-coordinate-label">纬度:</span>
                    <span class="location-coordinate-value">${e.lngLat.lat.toFixed(6)}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="location-section">
              <div class="location-section-header">
                <div class="location-icon location-icon-address">🏛️</div>
                <strong class="location-section-title">行政划分</strong>
              </div>
              <div class="location-data-box location-address-box">
                <div class="location-loading-text">
                  <div class="location-loading-spinner"></div>
                  正在获取位置信息...
                </div>
              </div>
            </div>
          </div>
        </div>
      `)
        .addTo(this.map!);

      // 调用反向地理编码获取行政划分
      try {
        if (!mapboxgl.accessToken) {
          throw new Error('Mapbox token 未配置');
        }

        const response = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${e.lngLat.lng},${e.lngLat.lat}.json?access_token=${mapboxgl.accessToken}&language=zh-CN`
        );
        const data = await response.json();

        let addressInfo = '未找到位置信息';
        if (data.features && data.features.length > 0) {
          // 提取行政划分信息
          const place = data.features[0];
          const context = place.context || [];

          let country = '';
          let region = '';
          let city = '';
          let district = '';

          // 解析上下文信息
          context.forEach((item: any) => {
            if (item.id.startsWith('country')) {
              country = item.text;
            } else if (item.id.startsWith('region')) {
              region = item.text;
            } else if (item.id.startsWith('place')) {
              city = item.text;
            } else if (item.id.startsWith('district')) {
              district = item.text;
            }
          });

          // 组装地址信息
          const addressParts = [country, region, city, district].filter(part => part);
          addressInfo = addressParts.join(' > ');

          if (!addressInfo) {
            addressInfo = place.place_name || '未知位置';
          }
        }

        // 更新弹出窗口内容
        if (currentPopup) {
          currentPopup.setHTML(`
          <div class="location-popup">
            <div class="location-popup-header">
              <div class="location-popup-title">
                <span class="location-popup-title-icon">📍</span>
                <h3 class="location-popup-title-text">位置信息</h3>
              </div>
            </div>
            
            <div class="location-popup-content">
              <div class="location-section">
                <div class="location-section-header">
                  <div class="location-icon location-icon-coordinate">🌍</div>
                  <strong class="location-section-title">坐标</strong>
                </div>
                <div class="location-data-box location-coordinate-box">
                  <div class="location-coordinate-text">
                    <div class="location-coordinate-row">
                      <span class="location-coordinate-label">经度:</span>
                      <span class="location-coordinate-value">${e.lngLat.lng.toFixed(6)}</span>
                    </div>
                    <div class="location-coordinate-row">
                      <span class="location-coordinate-label">纬度:</span>
                      <span class="location-coordinate-value">${e.lngLat.lat.toFixed(6)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div class="location-section">
                <div class="location-section-header">
                  <div class="location-icon location-icon-address">🏛️</div>
                  <strong class="location-section-title">行政划分</strong>
                </div>
                <div class="location-data-box location-address-box">
                  <div class="location-address-text">
                    ${addressInfo}
                  </div>
                </div>
              </div>
            </div>
          </div>
        `);
        }
      } catch (error) {
        console.error('获取位置信息失败:', error);
        // 如果请求失败，更新为错误信息
        if (currentPopup) {
          currentPopup.setHTML(`
            <div class="location-popup">
              <div class="location-popup-header">
                <div class="location-popup-title">
                  <span class="location-popup-title-icon">📍</span>
                  <h3 class="location-popup-title-text">位置信息</h3>
                </div>
              </div>
              
              <div class="location-popup-content">
                <div class="location-section">
                  <div class="location-section-header">
                    <div class="location-icon location-icon-coordinate">🌍</div>
                    <strong class="location-section-title">坐标</strong>
                  </div>
                  <div class="location-data-box location-coordinate-box">
                    <div class="location-coordinate-text">
                      <div class="location-coordinate-row">
                        <span class="location-coordinate-label">经度:</span>
                        <span class="location-coordinate-value">${e.lngLat.lng.toFixed(6)}</span>
                      </div>
                      <div class="location-coordinate-row">
                        <span class="location-coordinate-label">纬度:</span>
                        <span class="location-coordinate-value">${e.lngLat.lat.toFixed(6)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="location-section">
                  <div class="location-section-header">
                    <div class="location-icon location-icon-error">⚠️</div>
                    <strong class="location-section-title">行政划分</strong>
                  </div>
                  <div class="location-data-box location-error-box">
                    <div class="location-error-text">
                      获取位置信息失败
                    </div>
                  </div>
                </div>
              </div>
            </div>
         `);
        }
      }
    });

    // 地图移动事件
    this.map.on('move', () => {
      if (!this.map) return;
      const center = this.map.getCenter();
      const zoom = this.map.getZoom();
      console.log(`地图中心: ${center.lng.toFixed(4)}, ${center.lat.toFixed(4)}, 缩放级别: ${zoom.toFixed(2)}`);
    });

    // 错误处理
    this.map.on('error', (e) => {
      console.error('地图加载错误:', e);
    });
  }

  private showMapError() {
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
      mapContainer.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #fef2f2; color: #dc2626;">
          <div style="text-align: center; max-width: 400px; padding: 40px;">
            <div style="margin-bottom: 20px;">
              <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
              <h3 style="margin: 0 0 12px 0; color: #dc2626;">地图加载失败</h3>
              <p style="margin: 0; color: #7f1d1d; line-height: 1.5;">
                请检查 Mapbox Token 是否有效<br/>
                或稍后重试
              </p>
            </div>
            <button id="retry-btn" style="
              background: #dc2626;
              color: white;
              border: none;
              padding: 10px 24px;
              border-radius: 6px;
              font-size: 14px;
              cursor: pointer;
              transition: all 0.2s ease;
            ">
              重新配置
            </button>
          </div>
        </div>
      `;

      // 重新配置按钮
      const retryBtn = document.getElementById('retry-btn');
      retryBtn?.addEventListener('click', () => {
        this.showConfigScreen();
      });
    }
  }
}

// 等待 DOM 加载完成
document.addEventListener('DOMContentLoaded', async () => {
  const app = new App();
  await app.initialize();
});
