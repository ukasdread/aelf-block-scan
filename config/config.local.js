let aelf = {
    commonPrivateKey: 'f6e512a3c259e5f9af981d7f99d245aa5bc52fe448495e0b0dd56e8406be6f71',
    // the rpc URL of the AElf Chain Node.
    network: 'http://localhost:1234/chain',
    contract: '0xfe9f895a9f425c4ec3dc5c54bfce9908f03b'
};

let mysql = {
	aelf0: {
		// host
		// host: 'mysql.com',
		host: 'localhost',
		// 端口号
		port: '3306',
		// 用户名
		user: 'root',
		// 密码
		password: '',
		// 数据库名
		database: 'aelf_test',
		// database: 'aelf_test_34_212_171_27',
		// 链接池 链接上限
		connectionLimit : 100
	}
};

let log4js = {
    appenders: {
        scan: {
            type: 'file',
            filename: './log/scan.log'
        }
    },
    categories: {
        default: {
            appenders: ['scan'],
            level: 'error'
        }
    }
};

module.exports = {
	mysql: mysql,
	scanTimeInterval: 4000,
	scanLimit: 100,
	// scanLimit: 12,
	log4js: log4js,
	aelf: aelf
};