#!/usr/bin/env bash

# ╔══════════════════════════════════════╗
# ║      Emby In One 管理菜单            ║
# ╚══════════════════════════════════════╝

PROJECT_DIR="/opt/emby-in-one"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── 检测 compose 命令 ──
compose_cmd() {
  if docker compose version &>/dev/null; then
    docker compose "$@"
  elif command -v docker-compose &>/dev/null; then
    docker-compose "$@"
  else
    echo -e "${RED}[错误] 未找到 Docker Compose${NC}"
    return 1
  fi
}

# ── 读取配置 ──
get_config_value() {
  local key="$1"
  grep "^  ${key}:" "${PROJECT_DIR}/config/config.yaml" 2>/dev/null | head -1 | sed "s/.*${key}: *//" | tr -d "'" | tr -d '"'
}

get_port() {
  get_config_value "port"
}

# ── 按任意键返回 ──
pause_return() {
  echo ""
  read -n 1 -s -r -p "按任意键返回主菜单..."
  echo ""
}

# ── 格式化框线辅助 ──
print_box_top() {
  echo -e "${CYAN}┌──────────────────────────────────────┐${NC}"
}
print_box_mid() {
  echo -e "${CYAN}├──────────────┬───────────────────────┤${NC}"
}
print_box_sep() {
  echo -e "${CYAN}├──────────────┼───────────────────────┤${NC}"
}
print_box_bottom() {
  echo -e "${CYAN}└──────────────┴───────────────────────┘${NC}"
}
print_box_title() {
  printf "${CYAN}│${NC}${BOLD}%-38s${NC}${CYAN}│${NC}\n" "  $1"
}
print_box_row() {
  printf "${CYAN}│${NC} %-12s ${CYAN}│${NC} %-21s ${CYAN}│${NC}\n" "$1" "$2"
}

# ── 将秒数转为可读时长 ──
format_duration() {
  local total=$1
  local days=$((total / 86400))
  local hours=$(( (total % 86400) / 3600 ))
  local mins=$(( (total % 3600) / 60 ))
  local result=""
  if (( days > 0 )); then result="${days} 天 "; fi
  if (( hours > 0 )); then result="${result}${hours} 小时 "; fi
  if (( days == 0 )); then result="${result}${mins} 分钟"; fi
  echo "$result"
}

# ── 菜单函数 ──

do_start() {
  echo -e "${GREEN}▶ 正在启动服务...${NC}"
  echo ""
  cd "${PROJECT_DIR}" && compose_cmd up -d
  echo ""
  echo -e "${GREEN}✔ 服务已启动${NC}"
}

do_restart() {
  echo -e "${YELLOW}▶ 正在重启服务...${NC}"
  echo ""
  cd "${PROJECT_DIR}" && compose_cmd restart
  echo ""
  echo -e "${GREEN}✔ 服务已重启${NC}"
}

do_stop() {
  echo -e "${RED}▶ 正在关闭服务...${NC}"
  echo ""
  cd "${PROJECT_DIR}" && compose_cmd down
  echo ""
  echo -e "${GREEN}✔ 服务已关闭${NC}"
}

do_status() {
  echo -e "${CYAN}▶ 正在获取服务状态...${NC}"
  echo ""

  # 获取容器名
  local container
  container=$(cd "${PROJECT_DIR}" && compose_cmd ps -q 2>/dev/null | head -1)

  if [[ -z "$container" ]]; then
    print_box_top
    print_box_title "Emby In One 服务状态"
    print_box_mid
    print_box_row "容器状态" "● 未运行"
    print_box_bottom
    return
  fi

  # 用 docker inspect 获取信息
  local status started_at image container_id ports_raw
  status=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null)
  started_at=$(docker inspect --format '{{.State.StartedAt}}' "$container" 2>/dev/null)
  image=$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null)
  container_id=$(docker inspect --format '{{.Id}}' "$container" 2>/dev/null)
  container_id="${container_id:0:12}"

  # 解析端口
  local port_display
  port_display=$(docker inspect --format '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}} -> {{(index $conf 0).HostPort}}{{"\n"}}{{end}}' "$container" 2>/dev/null | head -1)
  if [[ -z "$port_display" ]]; then
    port_display="无端口映射"
  else
    # 简化 "8096/tcp -> 8096" 为 "8096 -> 8096"
    port_display=$(echo "$port_display" | sed 's|/tcp||g; s|/udp||g')
  fi

  # 计算运行时长
  local uptime_display="N/A"
  if [[ "$status" == "running" && -n "$started_at" ]]; then
    local start_epoch now_epoch diff
    start_epoch=$(date -d "$started_at" +%s 2>/dev/null)
    now_epoch=$(date +%s)
    if [[ -n "$start_epoch" ]]; then
      diff=$((now_epoch - start_epoch))
      uptime_display=$(format_duration "$diff")
    fi
  fi

  # 状态文字
  local status_text
  if [[ "$status" == "running" ]]; then
    status_text="${GREEN}● 运行中${NC}"
  elif [[ "$status" == "exited" ]]; then
    status_text="${RED}● 已停止${NC}"
  else
    status_text="${YELLOW}● ${status}${NC}"
  fi

  print_box_top
  print_box_title "Emby In One 服务状态"
  print_box_mid
  # 状态行需要特殊处理颜色
  printf "${CYAN}│${NC} %-12s ${CYAN}│${NC} " "容器状态"
  echo -e "${status_text}$(printf '%*s' $((21 - 10)) '')${CYAN}│${NC}"
  print_box_sep
  print_box_row "运行时长" "$uptime_display"
  print_box_sep
  print_box_row "端口映射" "$port_display"
  print_box_sep
  print_box_row "镜像" "$image"
  print_box_sep
  print_box_row "容器 ID" "$container_id"
  print_box_bottom
}

do_show_ip() {
  local port
  port=$(get_port)
  port=${port:-8096}

  echo -e "${CYAN}▶ 正在获取公网 IP 地址...${NC}"
  local ipv4 ipv6
  ipv4=$(curl -4 -s --max-time 5 ip.sb 2>/dev/null)
  ipv6=$(curl -6 -s --max-time 5 ip.sb 2>/dev/null)

  echo ""
  echo -e "${CYAN}┌─ 服务器 IP 地址 ────────────────────────────┐${NC}"
  echo -e "${CYAN}│${NC}"
  if [[ -n "$ipv4" ]]; then
    echo -e "${CYAN}│${NC}  IPv4:  ${GREEN}${ipv4}${NC}"
  else
    echo -e "${CYAN}│${NC}  IPv4:  ${RED}无法获取${NC}"
  fi
  if [[ -n "$ipv6" ]]; then
    echo -e "${CYAN}│${NC}  IPv6:  ${GREEN}${ipv6}${NC}"
  else
    echo -e "${CYAN}│${NC}  IPv6:  ${YELLOW}无法获取或不支持${NC}"
  fi
  echo -e "${CYAN}│${NC}"
  echo -e "${CYAN}├─ 访问地址 ──────────────────────────────────┤${NC}"
  echo -e "${CYAN}│${NC}"
  if [[ -n "$ipv4" ]]; then
    echo -e "${CYAN}│${NC}  访问地址:  ${GREEN}http://${ipv4}:${port}${NC}"
    echo -e "${CYAN}│${NC}  管理面板:  ${GREEN}http://${ipv4}:${port}/admin${NC}"
  fi
  if [[ -n "$ipv6" ]]; then
    echo -e "${CYAN}│${NC}  IPv6 访问: ${GREEN}http://[${ipv6}]:${port}${NC}"
  fi
  echo -e "${CYAN}│${NC}"
  echo -e "${CYAN}└──────────────────────────────────────────────┘${NC}"
  echo ""
}

do_show_admin() {
  local username password
  username=$(get_config_value "username")
  password=$(get_config_value "password")

  echo ""
  print_box_top
  print_box_title "管理员凭据"
  print_box_mid
  print_box_row "用户名" "$username"
  print_box_sep
  print_box_row "密码" "$password"
  print_box_bottom
  echo ""
}

do_change_username() {
  local current
  current=$(get_config_value "username")
  echo -e "  当前用户名: ${CYAN}${current}${NC}"
  echo ""
  read -rp "  请输入新用户名: " new_username
  if [[ -z "$new_username" ]]; then
    echo -e "${YELLOW}用户名不能为空，操作取消${NC}"
    return
  fi
  awk -v val="$new_username" '/^  username:/{print "  username: " val; next}1' "${PROJECT_DIR}/config/config.yaml" > "${PROJECT_DIR}/config/config.yaml.tmp" && mv "${PROJECT_DIR}/config/config.yaml.tmp" "${PROJECT_DIR}/config/config.yaml"
  echo ""
  echo -e "${GREEN}✔ 用户名已修改为: ${new_username}${NC}"
  echo -e "${YELLOW}▶ 正在重启服务使配置生效...${NC}"
  cd "${PROJECT_DIR}" && compose_cmd restart
  echo -e "${GREEN}✔ 完成${NC}"
}

do_change_password() {
  read -rp "  请输入新密码: " new_password
  if [[ -z "$new_password" ]]; then
    echo -e "${YELLOW}密码不能为空，操作取消${NC}"
    return
  fi
  awk -v val="$new_password" '/^  password:/{print "  password: " val; next}1' "${PROJECT_DIR}/config/config.yaml" > "${PROJECT_DIR}/config/config.yaml.tmp" && mv "${PROJECT_DIR}/config/config.yaml.tmp" "${PROJECT_DIR}/config/config.yaml"
  echo ""
  echo -e "${GREEN}✔ 密码已修改${NC}"
  echo -e "${YELLOW}▶ 正在重启服务使配置生效...${NC}"
  cd "${PROJECT_DIR}" && compose_cmd restart
  echo -e "${GREEN}✔ 完成${NC}"
}

do_logs() {
  echo -e "${CYAN}显示最近 50 条日志 (Ctrl+C 退出):${NC}"
  echo ""
  cd "${PROJECT_DIR}" && compose_cmd logs -f --tail 50
}

do_uninstall() {
  echo -e "${RED}${BOLD}⚠  即将卸载 Emby In One${NC}"
  echo ""
  echo -e "  此操作将停止并删除容器和镜像。"
  echo ""

  # 第一次确认
  read -rp "  确认卸载？(输入 yes 继续): " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo -e "${YELLOW}操作已取消${NC}"
    return
  fi

  echo ""

  # 询问是否删除数据
  read -rp "  是否删除配置和数据？(y/N): " del_data

  echo ""
  echo -e "${YELLOW}▶ 正在停止并删除容器和镜像...${NC}"
  cd "${PROJECT_DIR}" && compose_cmd down --rmi all 2>/dev/null

  if [[ "$del_data" =~ ^[yY] ]]; then
    echo -e "${YELLOW}▶ 正在删除所有数据和配置...${NC}"
    rm -rf "${PROJECT_DIR}"
  else
    echo -e "${YELLOW}▶ 保留 config/ 和 data/ 目录，删除其他文件...${NC}"
    find "${PROJECT_DIR}" -maxdepth 1 ! -name config ! -name data ! -name . -exec rm -rf {} +
  fi

  # 删除 CLI 自身
  echo -e "${YELLOW}▶ 正在删除 CLI 工具...${NC}"
  rm -f /usr/local/bin/emby-in-one
  hash -d emby-in-one 2>/dev/null

  echo ""
  echo -e "${GREEN}✔ 卸载完成${NC}"
  if [[ ! "$del_data" =~ ^[yY] ]]; then
    echo -e "${DIM}  配置和数据已保留在 ${PROJECT_DIR}/config 和 ${PROJECT_DIR}/data${NC}"
  fi
  echo ""
  echo -e "${DIM}  提示: 如果当前 shell 仍能找到 emby-in-one 命令，请执行 hash -r 或重新打开终端${NC}"
  echo ""
  exit 0
}

# ── 主菜单 ──
show_menu() {
  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║      Emby In One 管理菜单            ║${NC}"
  echo -e "${BOLD}╠══════════════════════════════════════╣${NC}"
  echo -e "${BOLD}║${NC}  1. 启动服务                         ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  2. 重启服务                         ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  3. 关闭服务                         ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  4. 查看服务状态                     ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  5. 查看服务器 IP 地址               ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  6. 查看管理员账号密码               ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  7. 修改管理员账号                   ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  8. 修改管理员密码                   ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  9. 查看日志                         ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC} 10. 卸载 Emby In One                 ${BOLD}║${NC}"
  echo -e "${BOLD}║${NC}  0. 退出                             ${BOLD}║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
  echo ""
}

# ── 检查项目目录 ──
if [[ ! -d "${PROJECT_DIR}" ]]; then
  echo -e "${RED}[错误] 项目目录 ${PROJECT_DIR} 不存在${NC}"
  echo -e "${YELLOW}请先运行 install.sh 安装 Emby In One${NC}"
  exit 1
fi

# ── 主循环 ──
while true; do
  clear
  show_menu
  read -rp "请选择操作 [0-10]: " choice
  echo ""
  case $choice in
    1) do_start; pause_return ;;
    2) do_restart; pause_return ;;
    3) do_stop; pause_return ;;
    4) do_status; pause_return ;;
    5) do_show_ip; pause_return ;;
    6) do_show_admin; pause_return ;;
    7) do_change_username; pause_return ;;
    8) do_change_password; pause_return ;;
    9) do_logs; pause_return ;;
    10) do_uninstall ;;
    0) clear; echo -e "${GREEN}再见！${NC}"; exit 0 ;;
    *) echo -e "${RED}无效选择，请重试${NC}"; pause_return ;;
  esac
done
