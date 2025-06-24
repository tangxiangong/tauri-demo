import mapboxgl from 'mapbox-gl';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || '';

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

  // 添加地理定位控件
  map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: {
      enableHighAccuracy: true
    },
    trackUserLocation: true,
    showUserLocation: true
  }), 'top-right');

  // 添加比例尺控件
  map.addControl(new mapboxgl.ScaleControl({
    maxWidth: 100,
    unit: 'metric'
  }), 'bottom-left');

  // 地图加载完成后的回调
  map.on('load', () => {
    console.log('地图加载完成');
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
