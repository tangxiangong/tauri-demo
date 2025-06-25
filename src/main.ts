import mapboxgl from 'mapbox-gl';
import {
  checkPermissions,
  requestPermissions,
  getCurrentPosition,
  watchPosition
} from '@tauri-apps/plugin-geolocation';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || '';

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

      // macOS 特殊处理
      if (permissions.location === 'prompt' || permissions.location === 'prompt-with-rationale') {
        console.log('请求位置权限...');

        // 在 macOS 上，可能需要多次尝试权限请求
        try {
          permissions = await requestPermissions(['location']);
          console.log('权限请求结果:', permissions);

          // 如果仍然是 prompt 状态，给用户更明确的指导
          if (permissions.location === 'prompt') {
            this.showLocationError({
              code: 1,
              message: '请在 系统偏好设置 > 安全性与隐私 > 隐私 > 位置服务 中允许此应用访问位置信息，然后重启应用。'
            });
            return;
          }
        } catch (error) {
          console.error('权限请求失败:', error);
          this.showLocationError({
            code: 1,
            message: '权限请求失败。请在系统设置中手动允许位置访问权限。'
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

  private showLocationError(error: GeolocationPositionError | any) {
    let errorMessage = '定位失败';
    let errorDetail = '';

    if (error.code) {
      switch (error.code) {
        case 1:
          errorMessage = '权限被拒绝';
          errorDetail = '请在浏览器或系统设置中允许位置访问权限';
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

    this.createNotification(errorMessage, `
      <div class="notification-content">
        <div class="notification-icon">❌</div>
        <div class="notification-text">
          <div class="notification-title">${errorMessage}</div>
          <div class="notification-subtitle">${errorDetail}</div>
        </div>
      </div>
    `, 'error');
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
      // 首先尝试检查Tauri权限
      const tauriPermission = await this.checkTauriLocationPermission();

      if (tauriPermission && tauriPermission.location === 'denied') {
        this.showLocationError({
          code: 1,
          message: '地理位置权限被拒绝，请在系统设置中允许位置访问'
        });
        return;
      }

      // 如果权限OK，先尝试使用Tauri API
      if (tauriPermission && tauriPermission.location === 'granted') {
        await this.tryTauriGeolocation();
      } else {
        // 否则使用Mapbox的定位控件
        this.geolocateControl.trigger();
      }

    } catch (error) {
      console.error('触发定位失败:', error);
      // 回退到Mapbox定位
      this.geolocateControl.trigger();
    }
  }
}

// 等待 DOM 加载完成
document.addEventListener('DOMContentLoaded', () => {
  // 初始化地图
  const map = new mapboxgl.Map({
    container: 'map', // 地图容器 ID
    style: 'mapbox://styles/mapbox/streets-v12', // 地图样式
    center: [116.3974, 39.9093], // 初始中心点 [经度, 纬度] - 北京
    zoom: 10, // 初始缩放级别
    pitch: 0, // 地图倾斜角度
    bearing: 0 // 地图旋转角度
  });

  // 添加导航控件（缩放按钮）
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  // 添加全屏控件
  map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

  // 初始化位置服务（替换原来的简单定位控件）
  const locationService = new LocationService(map);

  // 添加比例尺控件
  map.addControl(new mapboxgl.ScaleControl({
    maxWidth: 100,
    unit: 'metric'
  }), 'bottom-left');

  // 地图加载完成后的回调
  map.on('load', () => {
    console.log('地图加载完成');

    // 检查地理位置权限状态
    locationService.checkLocationPermission().then(permission => {
      if (permission) {
        console.log('地理位置权限状态:', permission);
      }
    });
  });

  // 存储当前的弹出窗口
  let currentPopup: mapboxgl.Popup | null = null;

  // 地图点击事件
  map.on('click', async (e) => {
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
      .addTo(map);

    // 调用反向地理编码获取行政划分
    try {
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
  map.on('move', () => {
    const center = map.getCenter();
    const zoom = map.getZoom();
    console.log(`地图中心: ${center.lng.toFixed(4)}, ${center.lat.toFixed(4)}, 缩放级别: ${zoom.toFixed(2)}`);
  });

  // 错误处理
  map.on('error', (e) => {
    console.error('地图加载错误:', e);
  });
});
