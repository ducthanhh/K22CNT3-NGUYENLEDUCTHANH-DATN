const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const session = require('express-session');
const app = express();
const port = 3000;

// --- 1. CẤU HÌNH SERVER ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'mat_khau_bi_mat_cua_rieng_ban',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

// --- 2. KẾT NỐI DATABASE ---
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Thanh2004', // Mật khẩu của bạn
    database: 'webtau'     // Tên DB của bạn
});

db.connect((err) => {
    if (err) console.error('❌ Lỗi kết nối MySQL:', err.message);
    else console.log('✅ Đã kết nối thành công với MySQL!');
});

// --- 3. MIDDLEWARE (Bảo vệ trang Admin/User) ---
function checkLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}

function checkAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') next();
    else res.send(`<script>alert('Bạn không phải Admin!'); window.location.href='/';</script>`);
}

// --- 4. CÁC ROUTE TRANG HTML ---
app.get('/login', (req, res) => res.sendFile(__dirname + '/public/login.html'));
app.get('/register', (req, res) => res.sendFile(__dirname + '/public/register.html'));
app.get('/payment-page', (req, res) => res.sendFile(__dirname + '/public/payment.html'));

app.get('/admin', checkLogin, checkAdmin, (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.get('/my-tickets', checkLogin, (req, res) => {
    res.sendFile(__dirname + '/public/my-tickets.html');
});

// --- 5. API DỮ LIỆU ---

// Thay p1.city -> p1.port_name
app.get('/api/schedules-list', (req, res) => {
    const sql = `
        SELECT s.schedule_id, p1.port_name AS diem_di, p2.port_name AS diem_den, s.departure_time, sh.ship_name
        FROM schedules s
        JOIN routes r ON s.route_id = r.route_id
        JOIN ports p1 ON r.origin_port_id = p1.port_id
        JOIN ports p2 ON r.destination_port_id = p2.port_id
        JOIN ships sh ON s.ship_id = sh.ship_id
        WHERE s.status = 'scheduled'
    `;
    db.query(sql, (err, results) => {
        if (err) return res.json([]);
        res.json(results);
    });
});


// API: Lấy thông tin chi tiết 1 chuyến (Check chỗ trống & Lấy giá)
app.get('/api/schedule-info', (req, res) => {
    // SỬA: Lấy ID từ tham số URL thay vì gán cứng số 1
    const scheduleId = req.query.id; 

    if (!scheduleId) return res.json({ error: true }); // Nếu không có ID thì báo lỗi ngay

    const sqlSchedule = `SELECT s.base_price, sh.capacity FROM schedules s JOIN ships sh ON s.ship_id = sh.ship_id WHERE s.schedule_id = ?`;
    const sqlBooked = `SELECT SUM(number_of_tickets) as booked FROM bookings WHERE schedule_id = ? AND status != 'cancelled'`;

    db.query(sqlSchedule, [scheduleId], (err, resSchedule) => {
        // Nếu lỗi hoặc không tìm thấy chuyến đó
        if (err || resSchedule.length === 0) return res.json({ error: true });
        
        db.query(sqlBooked, [scheduleId], (err, resBooked) => {
            const capacity = resSchedule[0].capacity;
            const price = resSchedule[0].base_price;
            const booked = resBooked[0].booked || 0;
            
            // Trả về giá và số chỗ còn lại
            res.json({ price: price, remaining: capacity - booked });
        });
    });
});

// --- 6. XỬ LÝ LOGIC CHÍNH ---

// Xử lý Đăng Ký
app.post('/register', (req, res) => {
    const { full_name, email, phone, password } = req.body;
    db.query("SELECT email FROM users WHERE email = ?", [email], (err, results) => {
        if (results.length > 0) return res.send(`<script>alert('Email đã tồn tại!'); window.history.back();</script>`);
        const sql = "INSERT INTO users (username, password, full_name, email, phone, role) VALUES (?, ?, ?, ?, ?, 'customer')";
        db.query(sql, [email, password, full_name, email, phone], () => {
            res.send(`<script>alert('Đăng ký thành công!'); window.location.href = '/login';</script>`);
        });
    });
});

// Xử lý Đăng Nhập
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query("SELECT * FROM users WHERE (email = ? OR username = ?) AND password = ?", [username, username, password], (err, results) => {
        if (results.length > 0) {
            req.session.user = results[0];
            if (results[0].role === 'admin') res.redirect('/admin');
            else res.redirect('/');
        } else {
            res.send(`<script>alert('Sai tài khoản/mật khẩu!'); window.location.href = '/login';</script>`);
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Xử lý Đặt Vé
app.post('/dat-ve', (req, res) => {
    const { ho_ten, email, sdt, schedule_id, so_khach } = req.body;
    console.log(`Đang xử lý đặt vé cho: ${email} - Chuyến số: ${schedule_id}`);

    const sqlCheckUser = "SELECT user_id FROM users WHERE email = ?";
    db.query(sqlCheckUser, [email], (err, results) => {
        if (err) return res.status(500).send("Lỗi Server: " + err.message);

        let userId;
        if (results.length > 0) {
            userId = results[0].user_id;
            checkSeatsAndBook(userId);
        } else {
            const sqlCreateUser = "INSERT INTO users (username, password, full_name, email, phone, role) VALUES (?, '123456', ?, ?, ?, 'customer')";
            db.query(sqlCreateUser, [email, ho_ten, email, sdt], (err, result) => {
                if (err) return res.status(500).send("Lỗi tạo user: " + err.message);
                userId = result.insertId;
                checkSeatsAndBook(userId);
            });
        }

        function checkSeatsAndBook(uId) {
            const sqlCheck = `
                SELECT s.base_price, sh.capacity,
                (sh.capacity - IFNULL((SELECT SUM(number_of_tickets) FROM bookings WHERE schedule_id = s.schedule_id AND status != 'cancelled'), 0)) as remaining
                FROM schedules s JOIN ships sh ON s.ship_id = sh.ship_id
                WHERE s.schedule_id = ?`;

            db.query(sqlCheck, [schedule_id], (err, checkResults) => {
                if (checkResults.length === 0) return res.send(`<script>alert('Chuyến đi không tồn tại!'); window.history.back();</script>`);
                
                const data = checkResults[0];
                if (parseInt(so_khach) > data.remaining) {
                    return res.send(`<script>alert('Chỉ còn ${data.remaining} chỗ!'); window.history.back();</script>`);
                }

                const tong_tien = so_khach * data.base_price;
                const sqlInsert = "INSERT INTO bookings (user_id, schedule_id, booking_date, number_of_tickets, total_price, status) VALUES (?, ?, NOW(), ?, ?, 'pending')";
                
                db.query(sqlInsert, [uId, schedule_id, so_khach, tong_tien], (err, result) => {
                    if (err) return res.status(500).send("Lỗi lưu vé: " + err.message);
                    res.redirect(`/payment-page?id=${result.insertId}&price=${tong_tien}`);
                });
            });
        }
    });
});

// Xử lý Thanh Toán
app.post('/confirm-payment', (req, res) => {
    const { booking_id, amount } = req.body;
    db.query("UPDATE bookings SET status = 'confirmed' WHERE booking_id = ?", [booking_id], () => {
        db.query("INSERT INTO payments (booking_id, amount, payment_method, status) VALUES (?, ?, 'qr_online', 'success')", [booking_id, amount], () => {
            res.send(`<div style="text-align:center;padding:50px"><h1 style="color:green">THANH TOÁN THÀNH CÔNG!</h1><a href="/">Về trang chủ</a></div>`);
        });
    });
});

// --- API CHO ADMIN (THỐNG KÊ & QUẢN LÝ) ---
app.get('/api/admin/stats', checkLogin, checkAdmin, (req, res) => {
    db.query("SELECT COUNT(*) as c FROM ships", (e1, r1) => {
        db.query("SELECT SUM(number_of_tickets) as c FROM bookings WHERE status='confirmed'", (e2, r2) => {
            db.query("SELECT SUM(total_price) as c FROM bookings WHERE status='confirmed'", (e3, r3) => {
                res.json({ ships: r1[0].c, tickets: r2[0].c || 0, revenue: r3[0].c || 0 });
            });
        });
    });
});

app.get('/api/all-bookings', checkLogin, checkAdmin, (req, res) => {
    const sql = `
        SELECT b.booking_id, u.full_name, u.phone, b.booking_date, b.number_of_tickets, b.total_price, b.status 
        FROM bookings b 
        JOIN users u ON b.user_id = u.user_id 
        ORDER BY b.booking_id DESC
    `;
    db.query(sql, (err, results) => res.json(results));
});

// --- API CHO KHÁCH HÀNG ---
app.get('/api/current-user', (req, res) => res.json(req.session.user || null));
app.get('/api/my-booking-history', checkLogin, (req, res) => {
    const sql = `SELECT b.booking_id, p1.city as from_city, p2.city as to_city, b.status, b.total_price, s.departure_time FROM bookings b JOIN schedules s ON b.schedule_id = s.schedule_id JOIN routes r ON s.route_id = r.route_id JOIN ports p1 ON r.origin_port_id = p1.port_id JOIN ports p2 ON r.destination_port_id = p2.port_id WHERE b.user_id = ? ORDER BY b.booking_date DESC`;
    db.query(sql, [req.session.user.user_id], (err, results) => res.json(results));
});

// --- CÁC API QUẢN TRỊ NÂNG CAO ---

// Thay p1.city -> p1.port_name
app.get('/api/admin/resources', checkLogin, checkAdmin, (req, res) => {
    db.query("SELECT * FROM ships", (e1, ships) => {
        // SỬA DÒNG DƯỚI ĐÂY:
        const sqlRoutes = `
            SELECT r.route_id, p1.port_name as from_city, p2.port_name as to_city 
            FROM routes r 
            JOIN ports p1 ON r.origin_port_id = p1.port_id 
            JOIN ports p2 ON r.destination_port_id = p2.port_id
        `;
        db.query(sqlRoutes, (e2, routes) => {
            res.json({ ships, routes });
        });
    });
});

// 2. API: Thêm Tàu Mới
app.post('/admin/add-ship', checkLogin, checkAdmin, (req, res) => {
    const { ship_name, capacity } = req.body;
    const sql = "INSERT INTO ships (ship_name, type_id, capacity, status) VALUES (?, 1, ?, 'active')";
    db.query(sql, [ship_name, capacity], (err, result) => {
        if (err) return res.status(500).send("Lỗi: " + err.message);
        res.redirect('/admin');
    });
});

// 3. API: Thêm Lịch Trình Mới
app.post('/admin/add-schedule', checkLogin, checkAdmin, (req, res) => {
    const { route_id, ship_id, departure_time, arrival_time, price } = req.body;
    const sql = "INSERT INTO schedules (route_id, ship_id, departure_time, arrival_time, base_price, status) VALUES (?, ?, ?, ?, ?, 'scheduled')";
    
    db.query(sql, [route_id, ship_id, departure_time, arrival_time, price], (err, result) => {
        if (err) return res.status(500).send("Lỗi: " + err.message);
        res.redirect('/admin');
    });
});

// 4. API: Cập nhật trạng thái vé (DUYỆT hoặc HỦY có lý do)
app.post('/admin/update-booking-status', checkLogin, checkAdmin, (req, res) => {
    const { booking_id, status, reason } = req.body;
    
    console.log(`Cập nhật vé #${booking_id} -> ${status}. Lý do: ${reason || 'Không'}`);

    // Chỉ cập nhật trạng thái (nếu muốn lưu lý do cần sửa DB thêm cột cancellation_reason)
    db.query("UPDATE bookings SET status = ? WHERE booking_id = ?", [status, booking_id], (err) => {
        if (err) return res.json({ error: true });
        res.json({ success: true });
    });
});

// 5. API: Lấy danh sách tàu (Admin view)
app.get('/api/admin/ships', checkLogin, checkAdmin, (req, res) => {
    const sql = "SELECT * FROM ships ORDER BY ship_id DESC";
    db.query(sql, (err, results) => {
        if (err) return res.json([]);
        res.json(results);
    });
});

// Thay p1.city -> p1.port_name
app.get('/api/admin/schedules', checkLogin, checkAdmin, (req, res) => {
    const sql = `
        SELECT s.schedule_id, sh.ship_name, 
               CONCAT(p1.port_name, ' ➝ ', p2.port_name) as route_name, 
               s.departure_time, s.base_price as price, s.status
        FROM schedules s
        JOIN ships sh ON s.ship_id = sh.ship_id
        JOIN routes r ON s.route_id = r.route_id
        JOIN ports p1 ON r.origin_port_id = p1.port_id
        JOIN ports p2 ON r.destination_port_id = p2.port_id
        ORDER BY s.departure_time DESC
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error("Lỗi lấy lịch trình:", err);
            return res.json([]);
        }
        res.json(results);
    });
});
// 7. [MỚI] API: Xóa lịch trình
app.post('/api/admin/delete-schedule', checkLogin, checkAdmin, (req, res) => {
    const { schedule_id } = req.body;
    // (Tùy chọn) Kiểm tra vé đã đặt trước khi xóa
    db.query("DELETE FROM schedules WHERE schedule_id = ?", [schedule_id], (err) => {
        if (err) return res.json({ error: true });
        res.json({ success: true });
    });
});

// --- CHẠY SERVER ---
app.listen(port, () => console.log(`🚀 Server đang chạy tại: http://localhost:${port}`));